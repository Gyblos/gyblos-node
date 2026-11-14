// Changes one original inference's rolling checkpoints; remaining authorization stays reserved until final ACK.
import { canonicalJson } from '@gyblos/protocol';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import {
  parseSessionBlockIntent,
  type SessionBlockIntent,
} from '@gyblos/protocol/session-blocks';

import { active } from './batch-session-common';
import type { BatchStore } from './batch-session-store';
import type { BatchRecord, BatchRequestBlocks } from './batch-session-types';

export function intentFor(value: unknown): SessionBlockIntent {
  try {
    return parseSessionBlockIntent(value);
  } catch {
    return sessionFail(SESSION_CODES.INVALID);
  }
}
export function sameBlock(
  previous: SessionBlockIntent | null,
  next: SessionBlockIntent,
): boolean {
  return previous !== null && canonicalJson(previous) === canonicalJson(next);
}
export function progressFor(
  record: BatchRecord,
  intent: SessionBlockIntent,
): BatchRequestBlocks {
  const request = record.requests[intent.bill.requestId];
  const progress = record.blocks?.[intent.bill.requestId];
  if (
    !request ||
    !progress ||
    intent.bill.requestDigest !== request.requestDigest ||
    intent.bill.maxAtomic !== request.maxAtomic ||
    BigInt(intent.bill.cumulativeAtomic) !==
      BigInt(progress.baseAtomic) + BigInt(intent.bill.chargedAtomic)
  )
    return sessionFail(SESSION_CODES.BINDING);
  if (
    BigInt(intent.bill.chargedAtomic) > BigInt(request.maxAtomic) ||
    BigInt(intent.bill.cumulativeAtomic) > BigInt(record.terms.depositAtomic)
  )
    return sessionFail(SESSION_CODES.LIMIT);
  return progress;
}
export async function prepareBlock(
  store: BatchStore,
  intent: SessionBlockIntent,
  now: number,
) {
  const previous = progressFor(store.read(), intent);
  if (
    sameBlock(previous.accepted, intent) ||
    sameBlock(previous.pending?.intent ?? null, intent)
  )
    return;
  await store.update((record) => {
    active(record, now);
    const progress = progressFor(record, intent);
    if (
      progress.pending ||
      progress.accepted?.terminal ||
      intent.index !== (progress.accepted ? progress.accepted.index + 1 : 0)
    )
      return sessionFail(SESSION_CODES.BINDING);
    const old = progress.accepted;
    if (
      old &&
      (intent.usage.inputTokens !== old.usage.inputTokens ||
        intent.usage.outputTokens < old.usage.outputTokens ||
        BigInt(intent.bill.chargedAtomic) < BigInt(old.bill.chargedAtomic))
    )
      return sessionFail(SESSION_CODES.BINDING);
    progress.pending = { intent, voucher: null };
    record.lastActivity = now;
  });
}
export function acknowledgeBlock(
  record: BatchRecord,
  intent: SessionBlockIntent,
  now: number,
) {
  const progress = progressFor(record, intent);
  progress.accepted = intent;
  progress.pending = null;
  const request = record.requests[intent.bill.requestId]!;
  if (intent.terminal) {
    request.bill = intent.bill;
    request.accepted = true;
  }
  record.lastActivity = now;
}
