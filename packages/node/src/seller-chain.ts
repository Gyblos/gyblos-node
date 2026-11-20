// Binds the seller’s devnet payment identity to its reusable channel registry.
import { createSolanaRpc } from '@solana/kit';

import {
  DEVNET,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  createUptoRecipientAccounts,
  type UptoRecipientAccountsRpc,
} from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { PaymentDescription } from '@gyblos/protocol/payment';

import { GENESIS_READ_MS, NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import { sellerChainSessions } from './seller-session-chain';
import type { SellerSessionComposition } from './seller-session-directory';

// The chain the RPC serves; tests inject one so they never reach the network.
export type GenesisReader = (rpcUrl: string) => Promise<string>;
export const readGenesis: GenesisReader = async (rpcUrl) =>
  String(
    await createSolanaRpc(rpcUrl)
      .getGenesisHash()
      .send({ abortSignal: AbortSignal.timeout(GENESIS_READ_MS) }),
  );

export interface SellerPayments {
  sessions: SellerSessionComposition;
  description: PaymentDescription;
  close(): Promise<void>;
}

export function sellerChainPayments(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoRecipientAccountsRpc,
): (
  role: RoleConfig,
  limits?: { maxSessions: number },
) => Promise<SellerPayments> {
  return async (inputRole, limits) => {
    const role = { ...inputRole };
    if (
      role.role !== P2P_ROLES.SELLER ||
      !role.payTo ||
      !role.facilitator ||
      !role.authorizer ||
      [role.facilitator, role.authorizer].includes(role.payTo)
    )
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING);
    // Devnet only: a role set up with another RPC must never spend its fee payer's real SOL.
    const served = await genesis(role.rpcUrl).catch(() => undefined);
    if (served !== DEVNET_GENESIS)
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_NETWORK_MISMATCH);
    const feePayer = await roleSigner(P2P_ROLES.SELLER, 'facilitator');
    const authorizer = await roleSigner(P2P_ROLES.SELLER, 'authorizer');
    if (
      feePayer.address !== role.facilitator ||
      authorizer.address !== role.authorizer
    )
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID);
    const recipients = createUptoRecipientAccounts(
      rpc ?? createSolanaRpc(role.rpcUrl),
      {
        feePayer,
        mint: role.mint,
        tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
        owners: [role.payTo, PROTOCOL_FEE.treasury, feePayer.address],
      },
    );
    await recipients.ensure().catch(() => {
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_ACCOUNTS_UNAVAILABLE);
    });
    const sessions = await sellerChainSessions({
      environment: process.env,
      rpcUrl: role.rpcUrl,
      feePayer,
      authorizer,
      maxSessions: limits?.maxSessions ?? BATCH_SESSION_DEFAULTS.maxSessions,
    });
    return {
      sessions,
      description: {
        network: DEVNET,
        mint: role.mint,
        payTo: role.payTo,
        feePayer: role.facilitator,
        authorizer: role.authorizer,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
      },
      close: () => sessions.registry.dispose(),
    };
  };
}
