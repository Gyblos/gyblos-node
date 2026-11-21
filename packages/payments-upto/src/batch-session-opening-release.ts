// Releases a seller opening whose deposit was never funded, so the seller never tries to close a channel
// that does not exist and the buyer can open again. Only this seller's fee payer completes the buyer's
// deposit, and the SDK records an attempt under the channel before it signs or sends.
import { getTransactionDecoder } from '@solana/kit';

import { SESSION_STATES, sessionFail } from '@gyblos/protocol/payment-session';

import type { openingFor } from './batch-session-checks';
import type { BatchStore } from './batch-session-store';
import type { BatchRecord } from './batch-session-types';
import { OPENING_RELEASE_FAILED } from './constants';

export type BatchOpening = ReturnType<typeof openingFor>;

// Deposit settlements still running for a session, including ones a timed-out wait left behind: waiting
// stops, the SDK does not, and it may yet send the deposit.
const settling = new WeakMap<BatchStore, number>();
export function trackDepositSettlement<T>(
  store: BatchStore,
  settle: Promise<T>,
) {
  let finished = false;
  settling.set(store, (settling.get(store) ?? 0) + 1);
  const settlement = settle.finally(() => {
    finished = true;
    settling.set(store, (settling.get(store) ?? 1) - 1);
  });
  return { settlement, finished: () => finished };
}
export const depositSettlementsRunning = (store: BatchStore) =>
  (settling.get(store) ?? 0) > 0;

const WIRE_KEY = /^batch:transaction:.+:wire$/;
// The SDK stores a signed attempt as a `…:wire` transaction keyed by signature before it reserves the
// channel key and sends. With no key naming the channel, an attempt of this deposit was never sent or
// failed on chain (the SDK drops the channel key only then, or discards the wire itself), so its wire is
// no evidence of funds.
function depositAttempts(
  pending: Record<string, string>,
  opening: BatchOpening,
) {
  const message = Buffer.from(
    getTransactionDecoder().decode(
      Buffer.from(opening.deposit.transaction, 'base64'),
    ).messageBytes,
  );
  return Object.entries(pending).flatMap(([key, wire]) => {
    if (!WIRE_KEY.test(key)) return [];
    try {
      const sent = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
      return message.equals(Buffer.from(sent.messageBytes)) ? [key] : [];
    } catch {
      return [];
    }
  });
}

// Call only when the chain never showed the channel and no settlement is still running. Any key naming
// the channel (deliberately wide, as the SDK's key format is internal) keeps everything. A release that
// cannot be written marks the opening failure, which stays the reported error.
export async function releaseUnsentOpening(
  store: BatchStore,
  opening: BatchOpening,
  failure: unknown,
) {
  const channelId = opening.voucher!.channelId;
  try {
    await store.update((state) => {
      if (
        state.state !== SESSION_STATES.OPENING ||
        state.channelId !== channelId ||
        Object.keys(state.pending).some((key) => key.includes(channelId))
      )
        return;
      for (const key of depositAttempts(state.pending, opening))
        delete state.pending[key];
      state.opening = null;
      state.channelId = '';
      state.voucher = null;
      state.released = true;
    });
  } catch {
    try {
      if (
        failure &&
        typeof failure === 'object' &&
        Object.isExtensible(failure)
      )
        Object.defineProperty(failure, OPENING_RELEASE_FAILED, { value: true });
    } catch {
      /* The opening failure is still reported. */
    }
  }
}

// Only an empty preparation can be released: no channel, opening, voucher, request, charge or pending
// attempt.
function releasedFor(value: unknown): true {
  if (value !== true) return sessionFail();
  return true;
}
export function releasedPreparation(record: BatchRecord) {
  return (
    record.state === SESSION_STATES.OPENING &&
    record.channelId === '' &&
    record.opening === null &&
    record.voucher === null &&
    record.cumulativeAtomic === '0' &&
    Object.keys(record.requests).length === 0 &&
    Object.keys(record.pending).length === 0 &&
    record.closing === null &&
    record.settlement === null
  );
}
// The stored record's optional `released` key and its parsed value.
export const releasedKey = (value: unknown) =>
  !!value && typeof value === 'object' && Object.hasOwn(value, 'released')
    ? ['released']
    : [];
export const releasedField = (row: Record<string, unknown>) =>
  Object.hasOwn(row, 'released') ? { released: releasedFor(row.released) } : {};
