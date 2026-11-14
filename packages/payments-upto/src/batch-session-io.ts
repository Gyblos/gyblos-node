// Coordinates only actual journal I/O per canonical file; SDK callbacks and inference stay outside.
// Created lazily and discarded when idle; existing private-file checks remain authoritative.
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchPaths } from './batch-session-types';

interface Access {
  tail: Promise<void>;
  pending: number;
}
let accesses: Map<string, Access> | undefined;

export async function withBatchState<T>(
  paths: BatchPaths,
  run: () => Promise<T>,
): Promise<T> {
  let key: string;
  try {
    key = join(
      realpathSync.native(dirname(paths.state)),
      basename(paths.state),
    );
  } catch (error) {
    // A never-created home has no journal to coordinate; the reader preserves its missing result.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return run();
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
  accesses ??= new Map();
  let access = accesses.get(key);
  if (!access) {
    access = { tail: Promise.resolve(), pending: 0 };
    accesses.set(key, access);
  }
  if (access.pending >= BATCH_SESSION_DEFAULTS.maxPendingOperations)
    return sessionFail(SESSION_CODES.BUSY);
  access.pending++;
  const task = access.tail.then(run);
  access.tail = task.then(
    () => {},
    () => {},
  );
  try {
    return await task;
  } finally {
    access.pending--;
    if (access.pending === 0) accesses.delete(key);
  }
}
