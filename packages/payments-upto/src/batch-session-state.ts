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
  ensurePrivateDirectory,
  readPrivateFile,
} from '@gyblos/runtime/private-file';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { batchOpeningAbsent } from './batch-opening-proof';
import { parseRecord, termsFor } from './batch-session-checks';
import { reserved } from './batch-session-common';
import { withBatchState } from './batch-session-io';
import type { BatchPaths, BatchRecord } from './batch-session-types';

export interface BatchStoredSession {
  terms: PaymentSessionTerms;
  snapshot: SessionSnapshot;
  pending: boolean;
  recoverable: boolean;
  notCreated?: true;
}
async function readRecord(paths: BatchPaths): Promise<BatchRecord | undefined> {
  try {
    await lstat(paths.state);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
  if (WINDOWS) return sessionFail(SESSION_CODES.UNAVAILABLE);
  try {
    await ensurePrivateDirectory(paths.directory);
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
  return {
    ...(notCreated ? { notCreated: true as const } : {}),
    terms: record.terms,
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
    recoverable:
      !notCreated && pending.some((request) => request.bill !== null),
  };
}

export function batchSessionTerminal(stored: BatchStoredSession | undefined) {
  return (
    stored !== undefined &&
    (stored.notCreated === true ||
      stored.snapshot.state === SESSION_STATES.CLOSED)
  );
}
