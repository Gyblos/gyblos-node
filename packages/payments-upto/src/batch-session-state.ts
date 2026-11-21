// Restores bounded private session metadata; SDK credentials never leave the financial adapter.
import { lstat } from 'node:fs/promises';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionSnapshot,
} from '@gyblos/protocol/payment-session';
import {
  ensurePrivatePaymentPaths,
  readPrivateFile,
} from '@gyblos/runtime/private-file';

import { batchOpeningAbsent, returnedOpening } from './batch-opening-proof';
import { parseRecord, termsFor } from './batch-session-checks';
import { reserved } from './batch-session-common';
import { withBatchState } from './batch-session-io';
import { emptyPreparation } from './batch-session-opening-release';
import type { BatchPaths, BatchRecord } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS } from './constants';

export interface BatchStoredSession {
  terms: PaymentSessionTerms;
  snapshot: SessionSnapshot;
  archivedProof?: true;
  pending: boolean;
  recoverable: boolean;
  notCreated?: true;
  openingPending?: true;
  openingReturned?: true;
  // A released never-funded opening: terminal for admission, and its buyer may open again.
  released?: true;
  // An empty preparation (released or not): no channel, opening, charge or pending attempt.
  empty?: true;
  priorSpentAtomic?: string;
}
async function readRecord(paths: BatchPaths): Promise<BatchRecord | undefined> {
  try {
    await lstat(paths.state);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
  try {
    await ensurePrivatePaymentPaths(paths);
    const text = await readPrivateFile(
      paths.state,
      BATCH_SESSION_DEFAULTS.stateBytes,
    );
    if (text === undefined) return sessionFail(SESSION_CODES.UNAVAILABLE);
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !('terms' in raw))
      return sessionFail();
    return parseRecord(raw, termsFor(raw.terms));
  } catch {
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
}
export async function readBatchRecord(paths: BatchPaths) {
  try {
    return await withBatchState(paths, () => readRecord(paths));
  } catch {
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
}
export async function inspectBatchSession(
  paths: BatchPaths,
): Promise<BatchStoredSession | undefined> {
  const record = await readBatchRecord(paths);
  if (!record) return undefined;
  return storedBatchSession(record);
}
export function storedBatchSession(record: BatchRecord): BatchStoredSession {
  const pending = Object.values(record.requests).filter(
    (request) => !request.accepted,
  );
  const notCreated = batchOpeningAbsent(record) !== undefined;
  const recoverable =
    !notCreated &&
    pending.some(
      (request) =>
        request.bill !== null ||
        !!record.blocks?.[request.requestId]?.pending ||
        !!record.blocks?.[request.requestId]?.accepted,
    );
  // parseRecord validated the settlement channel and deposit totals. Keep shortfalls
  // and outstanding delivery recovery in the active registry.
  const archivedProof =
    record.state === SESSION_STATES.CLOSED &&
    !!record.settlement?.transaction &&
    record.settlement.chargedAtomic === record.cumulativeAtomic &&
    !recoverable;
  return {
    ...(returnedOpening(record) && { openingReturned: true as const }),
    ...(record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_SENT] && {
      openingPending: true as const,
    }),
    ...(archivedProof ? { archivedProof: true as const } : {}),
    ...(notCreated ? { notCreated: true as const } : {}),
    ...(record.released ? { released: true as const } : {}),
    ...(emptyPreparation(record) ? { empty: true as const } : {}),
    terms: record.terms,
    ...(record.history
      ? { priorSpentAtomic: String(priorBatchSpent(record)) }
      : {}),
    snapshot: {
      channelId: record.channelId,
      state: record.state,
      expiresAt: record.terms.expiresAt,
      cumulativeAtomic: record.cumulativeAtomic,
      reservedAtomic: String(reserved(record)),
    },
    pending:
      !notCreated &&
      record.state !== SESSION_STATES.CLOSED &&
      pending.length > 0,
    recoverable,
  };
}

export function priorBatchSpent(record: BatchRecord): bigint {
  return (record.history ?? []).reduce(
    (total, entry) => total + BigInt(entry.settlement?.chargedAtomic ?? '0'),
    0n,
  );
}

// Closed with proof, or released never funded: such a session leaves the seller's buyer index.
export function batchSessionUnindexed(stored: BatchStoredSession | undefined) {
  return stored?.archivedProof === true || stored?.released === true;
}
// A session holding nothing (closed with proof, or an empty preparation, released or interrupted before
// its index row) may be found outside the index; its buyer comes back through admission.
export function batchSessionHoldsNothing(
  stored: BatchStoredSession | undefined,
) {
  return batchSessionUnindexed(stored) || stored?.empty === true;
}
export function batchSessionTerminal(stored: BatchStoredSession | undefined) {
  return (
    stored !== undefined &&
    (stored.notCreated === true ||
      stored.released === true ||
      stored.snapshot.state === SESSION_STATES.CLOSED)
  );
}
