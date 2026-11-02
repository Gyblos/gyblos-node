// Withdraws the paid buyer's stuck devnet channels from the buyer role: its wallet key signs and pays
// each step, its RPC is checked to be devnet, and the distribution comes from the network fee. It holds
// the journal, so the buyer must be stopped.
import { createSolanaRpc } from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  createUptoWithdrawal,
  openUptoBuyerJournal,
  WITHDRAW_STEPS,
  withdrawUptoBuyer,
  type UptoBuyerWithdrawOptions,
  type UptoBuyerWithdrawResult,
  type UptoBuyerWithdrawStep,
  type UptoWithdrawRpc,
} from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import { readGenesis, type GenesisReader } from './seller-chain';

export { WITHDRAW_STEPS, type UptoBuyerWithdrawStep };

export function buyerChainWithdraw(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoWithdrawRpc,
): (
  role: RoleConfig,
  report: UptoBuyerWithdrawOptions['report'],
) => Promise<UptoBuyerWithdrawResult[]> {
  return async (inputRole, report) => {
    const role = { ...inputRole };
    if (role.role !== P2P_ROLES.BUYER)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
    // Devnet only: this signs and spends fees from the buyer's wallet.
    const served = await genesis(role.rpcUrl).catch(() => undefined);
    if (served !== DEVNET_GENESIS)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH);
    const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER).catch(
      () => {
        throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
      },
    );
    const journal = await openUptoBuyerJournal({
      paths: buyerJournalPathsIn(process.env),
      now: Date.now,
    });
    try {
      return await withdrawUptoBuyer({
        journal,
        network: DEVNET,
        withdrawal: createUptoWithdrawal(rpc ?? createSolanaRpc(role.rpcUrl), {
          payer,
          network: DEVNET,
          tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
        }),
        mint: role.mint,
        treasury: PROTOCOL_FEE.treasury,
        protocolFeeBps: PROTOCOL_FEE.bps,
        maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
        now: Date.now,
        report,
      });
    } finally {
      await journal.close();
    }
  };
}
