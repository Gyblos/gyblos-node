// Parses bounded private checkpoint metadata and derives signed charge without storing response content.
import { canonicalJson } from '@gyblos/protocol';
import {
  controlAtomic,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  sessionFail,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';
import {
  parseSessionBlockIntent,
  type SessionBlockIntent,
} from '@gyblos/protocol/session-blocks';

import type { BatchRecord, BatchRequestBlocks } from './batch-session-types';

function effectiveBlock(
  progress: BatchRequestBlocks,
): SessionBlockIntent | null {
  return progress.pending?.voucher
    ? progress.pending.intent
    : progress.accepted;
}
export function blockCharge(progress: BatchRequestBlocks): bigint {
  return BigInt(effectiveBlock(progress)?.bill.chargedAtomic ?? '0');
}
export function parseBlocks(
  value: unknown,
  requests: BatchRecord['requests'],
  voucher: (value: unknown) => SessionVoucher,
): NonNullable<BatchRecord['blocks']> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > Object.keys(requests).length
  )
    return sessionFail();
  const blocks: NonNullable<BatchRecord['blocks']> = {};
  for (const [key, raw] of Object.entries(value)) {
    controlHex(key, PAYMENT_SESSION.requestIdBytes);
    if (!Object.hasOwn(requests, key)) return sessionFail();
    const row = controlObject(raw, ['baseAtomic', 'accepted', 'pending']);
    const pending =
      row.pending === null
        ? null
        : controlObject(row.pending, ['intent', 'voucher']);
    blocks[key] = {
      baseAtomic: controlAtomic(row.baseAtomic),
      accepted:
        row.accepted === null ? null : parseSessionBlockIntent(row.accepted),
      pending: pending
        ? {
            intent: parseSessionBlockIntent(pending.intent),
            voucher: pending.voucher === null ? null : voucher(pending.voucher),
          }
        : null,
    };
  }
  return blocks;
}
function bound(
  record: BatchRecord,
  request: BatchRecord['requests'][string],
  progress: BatchRequestBlocks,
  intent: SessionBlockIntent,
) {
  const bill = intent.bill;
  if (
    bill.requestId !== request.requestId ||
    bill.requestDigest !== request.requestDigest ||
    bill.maxAtomic !== request.maxAtomic ||
    BigInt(bill.cumulativeAtomic) !==
      BigInt(progress.baseAtomic) + BigInt(bill.chargedAtomic) ||
    BigInt(bill.cumulativeAtomic) > BigInt(record.terms.depositAtomic)
  )
    return sessionFail();
}
export function coherentBlocks(record: BatchRecord): bigint {
  let signed = 0n;
  if (!record.blocks) return signed;
  if (Object.values(record.requests).filter((row) => !row.accepted).length > 1)
    return sessionFail();
  for (const [key, progress] of Object.entries(record.blocks)) {
    const request = record.requests[key];
    if (
      !request ||
      BigInt(progress.baseAtomic) > BigInt(record.terms.depositAtomic)
    )
      return sessionFail();
    if (progress.accepted) bound(record, request, progress, progress.accepted);
    if (progress.pending) {
      const { intent, voucher } = progress.pending;
      bound(record, request, progress, intent);
      if (
        intent.index !==
          (progress.accepted ? progress.accepted.index + 1 : 0) ||
        progress.accepted?.terminal
      )
        return sessionFail();
      if (
        progress.accepted &&
        (intent.usage.inputTokens !== progress.accepted.usage.inputTokens ||
          intent.usage.outputTokens < progress.accepted.usage.outputTokens ||
          BigInt(intent.bill.chargedAtomic) <
            blockCharge({ ...progress, pending: null }))
      )
        return sessionFail();
      if (
        voucher &&
        (voucher.channelId !== record.channelId ||
          voucher.maxClaimableAmount !== intent.bill.cumulativeAtomic)
      )
        return sessionFail();
    }
    const complete =
      progress.accepted?.terminal === true && progress.pending === null;
    if (
      request.accepted !== complete ||
      (complete
        ? canonicalJson(request.bill) !== canonicalJson(progress.accepted!.bill)
        : request.bill !== null)
    )
      return sessionFail();
    signed += blockCharge(progress);
  }
  return signed;
}
