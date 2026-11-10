// Cross-checks durable financial totals and bindings; does not replace SDK signatures or chain evidence.
import { canonicalJson } from '@gyblos/protocol';
import { SESSION_STATES, sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchRecord } from './batch-session-types';

export function coherentRecord(record: BatchRecord) {
  const cumulative = BigInt(record.cumulativeAtomic);
  const accepted = Object.values(record.requests).filter(
    (request) => request.accepted,
  );
  const pending = Object.values(record.requests).filter(
    (request) => !request.accepted && request.bill !== null,
  );
  for (const request of Object.values(record.requests)) {
    if (request.accepted && request.bill === null) sessionFail();
    if (
      request.bill &&
      (request.bill.requestId !== request.requestId ||
        request.bill.requestDigest !== request.requestDigest ||
        request.bill.maxAtomic !== request.maxAtomic)
    )
      sessionFail();
  }
  const committed = accepted.reduce(
    (sum, request) => sum + BigInt(request.bill!.chargedAtomic),
    0n,
  );
  const signed =
    committed +
    pending.reduce(
      (sum, request) => sum + BigInt(request.bill!.chargedAtomic),
      0n,
    );
  if (cumulative !== committed && cumulative !== signed) sessionFail();
  if (record.opening && record.opening.voucher?.channelId !== record.channelId)
    sessionFail();
  if (
    record.voucher &&
    (record.voucher.channelId !== record.channelId ||
      record.voucher.maxClaimableAmount !== record.cumulativeAtomic)
  )
    sessionFail();
  if (
    record.state !== SESSION_STATES.OPENING &&
    (!record.opening || !record.voucher)
  )
    sessionFail();
  if (
    record.closing &&
    (record.closing.type === 'refund' || record.closing.type === 'seal') &&
    (canonicalJson(record.closing.channelConfig) !==
      canonicalJson(record.opening?.channelConfig) ||
      canonicalJson(record.closing.voucher) !== canonicalJson(record.voucher))
  )
    sessionFail();
  if (record.state === SESSION_STATES.CLOSED && !record.settlement)
    sessionFail();
  if (
    record.settlement &&
    (record.settlement.channelId !== record.channelId ||
      BigInt(record.settlement.chargedAtomic) >
        BigInt(record.cumulativeAtomic) ||
      BigInt(record.settlement.refundedAtomic) +
        BigInt(record.settlement.chargedAtomic) !==
        BigInt(record.terms.depositAtomic))
  )
    sessionFail();
}
