// The paid buyer's devnet payment client from the buyer role: its wallet key, its RPC (checked to be
// devnet) and the network fee, over the journal in the role's private payments directory. Only paid
// buying reaches this module; free buying never reads the wallet key.
import {
  buyerJournalPathsIn,
  DEVNET,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import {
  hasUnresolvedBuyerPayments,
  openUptoBuyerPayments,
  type UptoBuyerPayments,
  type UptoBuyerPaymentsOptions,
} from '@gyblos/payments-upto';
import {
  batchSessionTerminal,
  inspectBatchPool,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import { readGenesis, type GenesisReader } from './seller-chain';

export function buyerChainPayments(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoBuyerPaymentsOptions['rpc'],
): (role: RoleConfig, maxAtomic: string) => Promise<UptoBuyerPayments> {
  return async (role, maxAtomic) => {
    if (role.role !== P2P_ROLES.BUYER)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
    // Devnet only: a role set up with another RPC must never spend its wallet's real tokens.
    const served = await genesis(role.rpcUrl).catch(() => undefined);
    if (served !== DEVNET_GENESIS)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH);
    const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER).catch(
      () => {
        throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
      },
    );
    return openUptoBuyerPayments({
      rpcUrl: role.rpcUrl,
      policy: {
        network: DEVNET,
        mint: role.mint,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
        maxAtomic,
      },
      settings: UPTO_CHANNEL_SETTINGS,
      payer,
      paths: buyerJournalPathsIn(process.env),
      ...(rpc ? { rpc } : {}),
    });
  };
}

// Free quotes still respect unresolved signed payments, without starting the paid client or RPC.
export async function buyerPaymentsUnresolved(includeSession = true) {
  if (await hasUnresolvedBuyerPayments(buyerJournalPathsIn(process.env)))
    return true;
  if (!includeSession) return false;
  const pool = await inspectBatchPool(batchPoolPathsIn(process.env));
  if (
    pool.some(
      (entry) =>
        !entry.stored || entry.uncertain || !batchSessionTerminal(entry.stored),
    )
  )
    return true;
  const session = await inspectBatchSession(
    batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
  );
  return session !== undefined && !batchSessionTerminal(session);
}
