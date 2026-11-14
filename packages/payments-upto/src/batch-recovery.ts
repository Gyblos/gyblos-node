// Buyer-controlled recovery of the existing batch journal; never executes inference or trusts a seller reply.
import type { createSolanaRpc } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';
import { UPTO_WITHDRAW, type UptoWithdrawResult } from 'x402-upto-metered';

import { paymentSplits } from '@gyblos/protocol/payment-binding';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionCode,
  type SessionSettlement,
} from '@gyblos/protocol/payment-session';

import {
  batchRecoveryCheckpoint,
  retireCompletedControlIntent,
} from './batch-recovery-checkpoint';
import { resumeBatchControl } from './batch-recovery-resend';
import { openBuyer } from './batch-session-buyer';
import { batchSessionObserver } from './batch-session-observer';
import { readBatchRecord } from './batch-session-state';
import { openBatchStore, type BatchStore } from './batch-session-store';
import type { BatchBuyerOptions, BatchPaths } from './batch-session-types';
import { createBuyerRecoveryRpc } from './buyer-observation-transport';
import type { UptoBuyerWithdrawStep } from './buyer-withdraw';
import { WITHDRAW_STEPS } from './constants';
import { assertPaymentNetworkEnabled } from './mainnet';
import { createUptoWithdrawal, type UptoWithdrawRpc } from './withdrawal';

export interface BatchRecoveryOptions {
  paths: BatchPaths;
  payer: BatchBuyerOptions['payer'];
  rpcUrl: string;
  rpc?: ReturnType<typeof createSolanaRpc>;
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  policy?: Pick<PaymentSessionTerms, 'network' | 'mint'>;
}
export interface BatchRecoveryResult extends Omit<UptoWithdrawResult, 'step'> {
  // One channel spans many requests, so it has no single inference digest.
  requestDigest?: never;
  step: UptoBuyerWithdrawStep;
  channelId: string;
  settlement: SessionSettlement | null;
  failure: SessionCode | null;
}

export async function recoverBatchBuyer(
  input: BatchRecoveryOptions,
): Promise<BatchRecoveryResult | undefined> {
  input.signal?.throwIfAborted();
  const record = await readBatchRecord(input.paths);
  if (!record) return undefined;
  if (input.payer.address !== record.terms.buyer)
    return sessionFail(SESSION_CODES.BINDING);
  if (
    input.policy &&
    (input.policy.network !== record.terms.network ||
      input.policy.mint !== record.terms.mint)
  )
    return sessionFail(SESSION_CODES.BINDING);
  assertPaymentNetworkEnabled(record.terms.network);
  const common = {
    paths: input.paths,
    terms: record.terms,
    now: input.now ?? Date.now,
  };
  const store = await openBatchStore(common, record, true);
  try {
    if (!record.opening) {
      if (!record.hints)
        return {
          channelId: record.channelId,
          step: WITHDRAW_STEPS.REFUSED,
          transaction: null,
          confirmed: false,
          retryAfterSeconds: null,
          settlement: null,
          failure: SESSION_CODES.UNVERIFIED,
        };
      await openBuyer(
        { ...common, payer: input.payer, hints: async () => record.hints! },
        store,
        () => input.signal?.throwIfAborted(),
        true,
      );
    }
    const observer = batchSessionObserver({ ...input, terms: record.terms });
    const channelId = store.read().channelId;
    const known = await observer.settlement(channelId);
    if (known) return acceptRecoverySettlement(store, known);
    const status = await observer.bound(channelId);
    await retireCompletedControlIntent(store, status);
    const checkpoint = await batchRecoveryCheckpoint(
      store,
      input.payer,
      input.signal,
    );
    const rpc = input.rpc ?? createBuyerRecoveryRpc(input.rpcUrl);
    const transport = withdrawalRpc(rpc, checkpoint.lifetime);
    const withdrawal = createUptoWithdrawal(transport, {
      payer: input.payer,
      network: record.terms.network,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    input.signal?.throwIfAborted();
    await store.update((state) => {
      state.state = SESSION_STATES.CLOSING;
    });
    const outcome = await withdrawal.withdraw(
      {
        channelId,
        mint: record.terms.mint,
        rentPayer: record.terms.feePayer,
        maxAtomic: record.terms.depositAtomic,
        splits: paymentSplits(record.terms),
      },
      checkpoint.recovery,
    );
    await resumeBatchControl(
      transport,
      checkpoint.pending,
      outcome,
      input.signal,
    );
    input.signal?.throwIfAborted();
    const settled = await observer.settlement(channelId);
    return settled
      ? acceptRecoverySettlement(store, settled)
      : {
          ...outcome,
          channelId,
          settlement: null,
          confirmed:
            outcome.step === WITHDRAW_STEPS.DISTRIBUTED
              ? false
              : outcome.confirmed,
          retryAfterSeconds:
            outcome.step === WITHDRAW_STEPS.DISTRIBUTED
              ? UPTO_WITHDRAW.recheckSeconds
              : outcome.retryAfterSeconds,
          failure:
            outcome.step === WITHDRAW_STEPS.DISTRIBUTED
              ? SESSION_CODES.UNVERIFIED
              : null,
        };
  } finally {
    await store.dispose();
  }
}

function withdrawalRpc(
  rpc: ReturnType<typeof createSolanaRpc>,
  lifetime: Awaited<ReturnType<typeof batchRecoveryCheckpoint>>['lifetime'],
): UptoWithdrawRpc {
  return {
    getGenesisHash: rpc.getGenesisHash.bind(rpc),
    getAccountInfo: rpc.getAccountInfo.bind(rpc),
    getSlot: rpc.getSlot.bind(rpc),
    getBlockTime: rpc.getBlockTime.bind(rpc),
    getEpochInfo: rpc.getEpochInfo.bind(rpc),
    sendTransaction: rpc.sendTransaction.bind(rpc),
    getSignatureStatuses: rpc.getSignatureStatuses.bind(rpc),
    getLatestBlockhash: lifetime
      ? () => ({ send: async () => ({ value: lifetime }) })
      : rpc.getLatestBlockhash.bind(rpc),
  };
}
async function acceptRecoverySettlement(
  store: BatchStore,
  settlement: SessionSettlement,
): Promise<BatchRecoveryResult> {
  const current = store.read();
  if (
    settlement.channelId !== current.channelId ||
    BigInt(settlement.chargedAtomic) > BigInt(current.cumulativeAtomic) ||
    BigInt(settlement.chargedAtomic) + BigInt(settlement.refundedAtomic) !==
      BigInt(current.terms.depositAtomic) ||
    !settlement.transaction
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  await store.update((state) => {
    state.settlement = settlement;
    state.state = SESSION_STATES.CLOSED;
  });
  return {
    channelId: current.channelId,
    step: WITHDRAW_STEPS.DISTRIBUTED,
    transaction: settlement.transaction,
    confirmed: true,
    retryAfterSeconds: null,
    settlement,
    failure: null,
  };
}
