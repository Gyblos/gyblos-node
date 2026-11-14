// One bounded private session journal under an exclusive process lock; failed persistence poisons the handle.
// Financial operations and SDK checkpoints use separate queues so nested SDK writes cannot deadlock.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  PaymentSessionError,
  SESSION_CODES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { parseRecord } from './batch-session-checks';
import { withBatchState } from './batch-session-io';
import type { BatchCommonOptions, BatchRecord } from './batch-session-types';

export async function openBatchStore(
  options: BatchCommonOptions,
  initial: BatchRecord,
  requireExisting = false,
) {
  await ensurePrivateDirectory(options.paths.directory);
  const lock = await acquireProcessLock(options.paths.lock);
  let poisoned = false;
  let disposed = false;
  let current: BatchRecord;
  try {
    const text = await withBatchState(options.paths, () =>
      readPrivateFile(options.paths.state, BATCH_SESSION_DEFAULTS.stateBytes),
    );
    if (requireExisting && text === undefined)
      sessionFail(SESSION_CODES.UNAVAILABLE);
    current =
      text === undefined
        ? initial
        : parseRecord(JSON.parse(text), options.terms);
  } catch {
    await lock.release();
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
  let queue = Promise.resolve();
  function update(change: (state: BatchRecord) => void): Promise<void> {
    const writing = queue.then(async () => {
      if (disposed || poisoned) sessionFail(SESSION_CODES.UNAVAILABLE);
      await lock.verify();
      const draft = structuredClone(current);
      change(draft);
      const next = parseRecord(structuredClone(draft), options.terms);
      try {
        await withBatchState(options.paths, () =>
          writePrivateFile(
            options.paths.state,
            JSON.stringify(next),
            BATCH_SESSION_DEFAULTS.stateBytes,
          ),
        );
        current = next;
      } catch (error) {
        // A full file queue refuses before I/O; it is not an uncertain publication.
        if (
          error instanceof PaymentSessionError &&
          error.code === SESSION_CODES.BUSY
        )
          throw error;
        poisoned = true;
        sessionFail(SESSION_CODES.UNAVAILABLE);
      }
    });
    queue = writing.catch(() => {});
    return writing;
  }
  return {
    read: () => structuredClone(current),
    update,
    async dispose() {
      await queue;
      disposed = true;
      await lock.release();
    },
    pending: pendingStore(update, () => current),
  };
}
export type BatchStore = Awaited<ReturnType<typeof openBatchStore>>;
export function serial() {
  let queue = Promise.resolve();
  let queued = 0;
  return <T>(run: () => Promise<T>): Promise<T> => {
    if (queued >= BATCH_SESSION_DEFAULTS.maxPendingOperations)
      return Promise.reject(new PaymentSessionError(SESSION_CODES.BUSY));
    queued++;
    const task = queue
      .then(run)
      .catch((error: unknown) => {
        if (error instanceof PaymentSessionError) throw error;
        return sessionFail(SESSION_CODES.UNAVAILABLE);
      })
      .finally(() => {
        queued--;
      });
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
}

function pendingStore(
  update: (change: (state: BatchRecord) => void) => Promise<void>,
  read: () => BatchRecord,
) {
  return {
    get: async (key: string) => read().pending[key],
    set: (key: string, value: string) =>
      update((state) => {
        state.pending[key] = value;
      }),
    delete: (key: string) =>
      update((state) => {
        delete state.pending[key];
      }),
    async setIfAbsent(key: string, value: string) {
      let inserted = false;
      await update((state) => {
        if (!Object.hasOwn(state.pending, key)) {
          state.pending[key] = value;
          inserted = true;
        }
      });
      return inserted;
    },
    async deleteIfEquals(key: string, value: string) {
      let removed = false;
      await update((state) => {
        if (state.pending[key] === value) {
          delete state.pending[key];
          removed = true;
        }
      });
      return removed;
    },
  };
}
