// Persists verified intent before signing and the exact voucher before sending; recovery never runs an engine.
import { signBatchVoucher } from '@x402/svm/batch-settlement/client';

import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import type { SessionBlockIntent } from '@gyblos/protocol/session-blocks';

import {
  acknowledgeBlock,
  intentFor,
  prepareBlock,
  progressFor,
  sameBlock,
} from './batch-block-operations';
import { atomic } from './batch-session-checks';
import type { BatchStore } from './batch-session-store';
import type { BatchBuyerOptions } from './batch-session-types';

async function signStored(
  options: BatchBuyerOptions,
  store: BatchStore,
  intent: SessionBlockIntent,
  check?: () => void,
) {
  const state = store.read();
  const progress = progressFor(state, intent);
  if (sameBlock(progress.accepted, intent)) {
    if (state.voucher?.maxClaimableAmount !== intent.bill.cumulativeAtomic)
      return sessionFail(SESSION_CODES.BINDING);
    return state.voucher;
  }
  if (!progress.pending || !sameBlock(progress.pending.intent, intent))
    return sessionFail(SESSION_CODES.BINDING);
  if (progress.pending.voucher) return progress.pending.voucher;
  if (
    state.state !== SESSION_STATES.OPEN ||
    options.now() >= options.terms.expiresAt
  )
    return sessionFail(SESSION_CODES.CLOSED);
  check?.();
  const voucher = await signBatchVoucher(options.payer, {
    channelId: state.channelId,
    maxClaimableAmount: BigInt(intent.bill.cumulativeAtomic),
    expiresAt: PAYMENT_SESSION.voucherExpiry,
  });
  // A signature may already exist after cancellation. Preserve it before reporting the cancellation.
  await store.update((record) => {
    const pending = progressFor(record, intent).pending;
    if (!pending || !sameBlock(pending.intent, intent))
      return sessionFail(SESSION_CODES.BINDING);
    pending.voucher = voucher;
    record.voucher = voucher;
    record.cumulativeAtomic = intent.bill.cumulativeAtomic;
    record.lastActivity = options.now();
  });
  check?.();
  return voucher;
}
export async function approveBuyerBlock(
  options: BatchBuyerOptions,
  store: BatchStore,
  input: SessionBlockIntent,
  verifiedAtomic: string,
  check?: () => void,
) {
  const intent = intentFor(input);
  if (intent.bill.chargedAtomic !== atomic(verifiedAtomic))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  check?.();
  await prepareBlock(store, intent, options.now());
  return signStored(options, store, intent, check);
}
export async function acknowledgeBuyerBlock(
  options: BatchBuyerOptions,
  store: BatchStore,
  input: SessionBlockIntent,
) {
  const intent = intentFor(input);
  const previous = progressFor(store.read(), intent);
  if (sameBlock(previous.accepted, intent)) return;
  if (!previous.pending?.voucher || !sameBlock(previous.pending.intent, intent))
    return sessionFail(SESSION_CODES.BINDING);
  await store.update((record) =>
    acknowledgeBlock(record, intent, options.now()),
  );
}
export async function recoverBuyerBlock(
  options: BatchBuyerOptions,
  store: BatchStore,
) {
  const record = store.read();
  if (record.state !== SESSION_STATES.OPEN) return undefined;
  for (const [id, progress] of Object.entries(record.blocks ?? {})) {
    if (record.requests[id]?.accepted) continue;
    const intent = progress.pending?.intent ?? progress.accepted;
    if (intent)
      return { intent, voucher: await signStored(options, store, intent) };
  }
  return undefined;
}
