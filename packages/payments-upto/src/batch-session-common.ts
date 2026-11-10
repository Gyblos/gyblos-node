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

import { requestFor } from './batch-session-checks';
import type { BatchStore } from './batch-session-store';
import type { BatchRecord } from './batch-session-types';

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
  return Object.values(record.requests)
    .filter((request) => !request.accepted)
    .reduce((total, request) => total + BigInt(request.maxAtomic), 0n);
}
export function snapshot(store: BatchStore): SessionSnapshot {
  const state = store.read();
  return {
    channelId: state.channelId,
    state: state.state,
    cumulativeAtomic: state.cumulativeAtomic,
    reservedAtomic: String(reserved(state)),
  };
}
export function active(record: BatchRecord, now: number) {
  if (record.state !== SESSION_STATES.OPEN || now >= record.terms.expiresAt)
    sessionFail(SESSION_CODES.CLOSED);
}
export async function reserve(store: BatchStore, input: unknown, now: number) {
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
    state.lastActivity = now;
  });
}
