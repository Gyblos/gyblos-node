// Shared session accounting and lifecycle guards; no engine calls or payment broadcasts.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionSnapshot,
} from '@gyblos/protocol/payment-session';

import { blockCharge } from './batch-block-state';
import { batchOpeningAbsent } from './batch-opening-proof';
import { requestFor } from './batch-session-checks';
import type { BatchStore } from './batch-session-store';
import type { BatchRecord } from './batch-session-types';
import { BATCH_BLOCK_STATE } from './constants';

export function initialRecord(
  terms: PaymentSessionTerms,
  now: number,
): BatchRecord {
  return {
    version: PAYMENT_SESSION.version,
    terms,
    channelId: '',
    state: SESSION_STATES.OPENING,
    hints: null,
    salt: '0',
    opening: null,
    cumulativeAtomic: '0',
    voucher: null,
    requests: {},
    lastActivity: now,
    closing: null,
    settlement: null,
    pending: {},
  };
}
export function reserved(record: BatchRecord): bigint {
  if (record.state === SESSION_STATES.CLOSED || batchOpeningAbsent(record))
    return 0n;
  return Object.values(record.requests)
    .filter((request) => !request.accepted)
    .reduce((total, request) => {
      const progress = record.blocks?.[request.requestId];
      if (progress)
        return total + BigInt(request.maxAtomic) - blockCharge(progress);
      const signed =
        request.bill &&
        BigInt(request.bill.cumulativeAtomic) <=
          BigInt(record.cumulativeAtomic);
      return total + (signed ? 0n : BigInt(request.maxAtomic));
    }, 0n);
}

export function snapshot(store: BatchStore): SessionSnapshot {
  const state = store.read();
  return {
    expiresAt: state.terms.expiresAt,
    channelId: state.channelId,
    state: state.state,
    cumulativeAtomic: state.cumulativeAtomic,
    reservedAtomic: String(reserved(state)),
  };
}
export function active(record: BatchRecord, now: number) {
  if (
    batchOpeningAbsent(record) ||
    record.state !== SESSION_STATES.OPEN ||
    now >= record.terms.expiresAt
  )
    sessionFail(SESSION_CODES.CLOSED);
}
export async function reserve(
  store: BatchStore,
  input: unknown,
  now: number,
  blocks = false,
) {
  const request = requestFor(input);
  await store.update((state) => {
    active(state, now);
    if (
      Object.hasOwn(state.requests, request.requestId) ||
      Object.values(state.requests).some(
        (previous) => previous.requestDigest === request.requestDigest,
      )
    )
      sessionFail(SESSION_CODES.BINDING);
    if (
      Object.keys(state.requests).length >= BATCH_SESSION_DEFAULTS.maxRequests
    )
      sessionFail(SESSION_CODES.LIMIT);
    // Stage one is sequential; reservations remain separate records for future concurrency.
    if (Object.values(state.requests).some((previous) => !previous.accepted))
      sessionFail(SESSION_CODES.BUSY);
    if (
      BigInt(state.cumulativeAtomic) +
        reserved(state) +
        BigInt(request.maxAtomic) >
      BigInt(state.terms.depositAtomic)
    )
      sessionFail(SESSION_CODES.LIMIT);
    state.requests[request.requestId] = {
      ...request,
      bill: null,
      accepted: false,
    };
    if (blocks) {
      state.version = BATCH_BLOCK_STATE.version;
      state.blocks ??= {};
      state.blocks[request.requestId] = {
        baseAtomic: state.cumulativeAtomic,
        accepted: null,
        pending: null,
      };
    }
    state.lastActivity = now;
  });
}
