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
import { batchPoolPathsIn } from '@gyblos/config/home';
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
import {
  recoverBatchPool,
  type BatchRecoveryOptions,
  type BatchRecoveryResult,
} from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
} from '@gyblos/runtime/private-file';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import { readGenesis, type GenesisReader } from './seller-chain';

export { WITHDRAW_STEPS, type UptoBuyerWithdrawStep };
type BuyerWithdrawalResult = UptoBuyerWithdrawResult | BatchRecoveryResult;

export function buyerChainWithdraw(
  genesis: GenesisReader = readGenesis,
  rpc?: UptoWithdrawRpc,
  batchRpc?: BatchRecoveryOptions['rpc'],
): (
  role: RoleConfig,
  report: (result: BuyerWithdrawalResult) => Promise<void>,
) => Promise<BuyerWithdrawalResult[]> {
  return async (inputRole, report) => {
    if (inputRole.role !== P2P_ROLES.BUYER)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
    const paths = batchPoolPathsIn(process.env);
    const lock = await ensurePrivateDirectory(paths.directory)
      .then(() => acquireProcessLock(paths.runtimeLock))
      .catch(() => {
        throw new NodeError(NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE);
      });
    try {
      const { rpcUrl, mint } = inputRole;
      // Devnet only: this signs and spends fees from the buyer's wallet.
      const served = await genesis(rpcUrl).catch(() => undefined);
      if (served !== DEVNET_GENESIS)
        throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH);
      const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER).catch(
        () => {
          throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
        },
      );
      const legacy = await withdrawLegacy(inputRole, payer, report, rpc);
      const batch = await recoverBatchPool({
        paths,
        payer,
        rpcUrl,
        policy: { network: DEVNET, mint },
        ...(batchRpc ? { rpc: batchRpc } : {}),
      });
      for (const result of batch) await report(result);
      return [...legacy, ...batch];
    } finally {
      await lock.release();
    }
  };
}

async function withdrawLegacy(
  role: RoleConfig,
  payer: Awaited<ReturnType<typeof roleSigner>>,
  report: UptoBuyerWithdrawOptions['report'],
  rpc?: UptoWithdrawRpc,
) {
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
}
