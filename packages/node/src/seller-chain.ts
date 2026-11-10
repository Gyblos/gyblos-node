// The daemon's devnet payment server from the seller role: its payout, fee payer and authorizer keys,
// its RPC (checked to be devnet) and the network fee, over the ledger in the role's private payments
// directory. Only paid offers reach this module; it never touches the role's other keys.
import { createSolanaRpc } from '@solana/kit';

import {
  CLEANUP,
  DEVNET,
  DEVNET_GENESIS,
  paymentPathsIn,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import { SELLER_SESSION_BUYER_ENV } from '@gyblos/config/batch-session';
import { batchSessionPathsIn } from '@gyblos/config/home';
import {
  openUptoSellerPayments,
  type UptoSellerPaymentsOptions,
} from '@gyblos/payments-upto';
import { openBatchSellerBackend } from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES, PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { controlHex } from '@gyblos/protocol/control-validation';
import { PaymentError } from '@gyblos/protocol/payment';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { GENESIS_READ_MS, NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import type { SellerPayments } from './seller-paid';

// The chain the RPC serves; tests inject one so they never reach the network.
export type GenesisReader = (rpcUrl: string) => Promise<string>;
export const readGenesis: GenesisReader = async (rpcUrl) =>
  String(
    await createSolanaRpc(rpcUrl)
      .getGenesisHash()
      .send({ abortSignal: AbortSignal.timeout(GENESIS_READ_MS) }),
  );

// Role keys are read from the process home (as every role file is), so the ledger lives there too.
// Tests inject the RPC; production reads the role's.
export function sellerChainPayments(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoSellerPaymentsOptions['rpc'],
): (role: RoleConfig) => Promise<SellerPayments> {
  return async (role) => {
    const pinned = process.env[SELLER_SESSION_BUYER_ENV];
    if (pinned !== undefined) {
      controlHex(pinned);
      if (WINDOWS) return sessionFail(SESSION_CODES.UNAVAILABLE);
    }
    if (
      role.role !== P2P_ROLES.SELLER ||
      role.payTo === undefined ||
      role.facilitator === undefined ||
      role.authorizer === undefined
    )
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING);
    // Devnet only: a role set up with another RPC must never spend its fee payer's real SOL.
    const served = await genesis(role.rpcUrl).catch(() => undefined);
    if (served !== DEVNET_GENESIS)
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_NETWORK_MISMATCH);
    const feePayer = await roleSigner(P2P_ROLES.SELLER, 'facilitator');
    const authorizer = await roleSigner(P2P_ROLES.SELLER, 'authorizer');
    const sessions =
      pinned === undefined
        ? undefined
        : {
            buyerNodeId: pinned,
            backend: openBatchSellerBackend({
              rpcUrl: role.rpcUrl,
              feePayer,
              authorizer,
              paths: batchSessionPathsIn(process.env, P2P_ROLES.SELLER),
            }),
          };
    const paid = await openUptoSellerPayments({
      rpcUrl: role.rpcUrl,
      ...(rpc ? { rpc } : {}),
      description: {
        network: DEVNET,
        mint: role.mint,
        payTo: role.payTo,
        feePayer: role.facilitator,
        authorizer: role.authorizer,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
      },
      settings: UPTO_CHANNEL_SETTINGS,
      feePayer,
      authorizer,
      paths: paymentPathsIn(process.env, P2P_ROLES.SELLER),
      cleanup: {
        intervalSecs: CLEANUP.intervalSeconds,
        abandonGraceSecs: CLEANUP.abandonGraceSeconds,
      },
    }).catch((error: unknown) => {
      // The only chain call while opening: making the token accounts a claim pays into exist.
      throw error instanceof PaymentError &&
        error.code === PAYMENT_ERROR_CODES.UNAVAILABLE
        ? new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_ACCOUNTS_UNAVAILABLE)
        : error;
    });
    return { ...paid, sessions };
  };
}
