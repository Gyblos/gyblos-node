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
import { openUptoSellerPayments } from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import type { SellerPayments } from './seller-paid';

// The chain the RPC serves; tests inject one so they never reach the network.
type GenesisReader = (rpcUrl: string) => Promise<string>;
const readGenesis: GenesisReader = async (rpcUrl) =>
  String(await createSolanaRpc(rpcUrl).getGenesisHash().send());

// Role keys are read from the process home (as every role file is), so the ledger lives there too.
export function sellerChainPayments(
  genesis: GenesisReader = readGenesis,
): (role: RoleConfig) => Promise<SellerPayments> {
  return async (role) => {
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
    const payments = await openUptoSellerPayments({
      rpcUrl: role.rpcUrl,
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
      feePayer: await roleSigner(P2P_ROLES.SELLER, 'facilitator'),
      authorizer: await roleSigner(P2P_ROLES.SELLER, 'authorizer'),
      paths: paymentPathsIn(process.env, P2P_ROLES.SELLER),
      cleanup: {
        intervalSecs: CLEANUP.intervalSeconds,
        abandonGraceSecs: CLEANUP.abandonGraceSeconds,
      },
    });
    return payments;
  };
}
