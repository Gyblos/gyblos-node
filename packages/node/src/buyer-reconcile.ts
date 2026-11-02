// Reconciles the paid buyer's journal on devnet from the buyer role: its RPC (checked to be devnet), its
// wallet address and mint, and the network's fee treasury. It only reads the chain and never signs, so
// no key file is read; it holds the journal, so the buyer must be stopped.
import { createSolanaRpc } from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
} from '@gyblos/config';
import {
  openUptoBuyerJournal,
  RECONCILE_OUTCOMES,
  reconcileUptoBuyer,
  type UptoReconcileOptions,
  type UptoReconcileResult,
} from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import type { RoleConfig } from './roles';
import { readGenesis, type GenesisReader } from './seller-chain';

export { RECONCILE_OUTCOMES };

export function buyerChainReconcile(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoReconcileOptions['rpc'],
): (
  role: RoleConfig,
  expected: UptoReconcileOptions['expected'],
  report: UptoReconcileOptions['report'],
) => Promise<UptoReconcileResult[]> {
  return async (role, expected, report) => {
    if (role.role !== P2P_ROLES.BUYER)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
    const served = await genesis(role.rpcUrl).catch(() => undefined);
    if (served !== DEVNET_GENESIS)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH);
    const journal = await openUptoBuyerJournal({
      paths: buyerJournalPathsIn(process.env),
      now: Date.now,
    });
    try {
      return await reconcileUptoBuyer({
        journal,
        network: DEVNET,
        rpc: rpc ?? createSolanaRpc(role.rpcUrl),
        payer: role.buyer,
        mint: role.mint,
        treasury: PROTOCOL_FEE.treasury,
        expected,
        report,
      });
    } finally {
      await journal.close();
    }
  };
}
