// Serializes private reusable-journal reads and durable writes under one verified process lock.
// An ambiguous write poisons the instance; opening it again always reloads the actual file.
import {
  buyerReusableJournalPathsIn,
  type HomeEnvironment,
} from '@gyblos/config/home';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { REUSABLE_JOURNAL } from './constants';
import {
  parseDocument,
  unavailable,
  type ReusableChannelEntry,
} from './reusable-journal-model';

export interface ReusableJournalSession {
  entries: ReusableChannelEntry[];
  save(): Promise<void>;
  maxBytes: number;
}
export interface ReusableJournalStore {
  run<T>(
    operation: (session: ReusableJournalSession) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export async function openReusableStore(
  environment: HomeEnvironment,
  maxBytes: number,
): Promise<ReusableJournalStore> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > REUSABLE_JOURNAL.maxBytes
  )
    unavailable();
  const paths = buyerReusableJournalPathsIn({ ...environment });
  let lock: ProcessLock;
  try {
    await ensurePrivateDirectory(paths.directory);
    lock = await acquireProcessLock(paths.lock);
  } catch {
    return unavailable();
  }
  return createStore(paths.state, lock, maxBytes);
}
function createStore(
  path: string,
  lock: ProcessLock,
  maxBytes: number,
): ReusableJournalStore {
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let poisoned = false;
  async function load(): Promise<ReusableChannelEntry[]> {
    try {
      await lock.verify();
      const source = await readPrivateFile(path, maxBytes);
      return source === undefined ? [] : await parseDocument(source);
    } catch {
      return unavailable();
    }
  }
  async function save(entries: ReusableChannelEntry[]): Promise<void> {
    const source = JSON.stringify({
      version: REUSABLE_JOURNAL.version,
      entries,
    });
    await parseDocument(source);
    try {
      await lock.verify();
      await writePrivateFile(path, source, maxBytes);
    } catch {
      poisoned = true;
      unavailable();
    }
  }
  function run<T>(
    operation: (session: ReusableJournalSession) => Promise<T>,
  ): Promise<T> {
    if (closing || poisoned)
      return Promise.reject(
        new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
      );
    const next = queue.then(async () => {
      if (poisoned) return unavailable();
      try {
        const entries = await load();
        return await operation({
          entries,
          save: () => save(entries),
          maxBytes,
        });
      } catch {
        return unavailable();
      }
    });
    queue = next.catch(() => {});
    return next;
  }
  return {
    run,
    close() {
      closing ??= queue.then(async () => {
        try {
          await lock.release();
        } catch {
          unavailable();
        }
      });
      return closing;
    },
  };
}
