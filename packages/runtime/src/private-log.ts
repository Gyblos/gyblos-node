import { PRIVATE_LOG_LIMITS } from '@gyblos/config';

import {
  PRIVATE_LOG_CODES,
  PRIVATE_LOG_STATES,
  PRIVATE_LOG_WARNING,
  type PrivateLogCode,
  type PrivateLogState,
} from './constants.js';
import {
  openPrivateLogFile,
  PrivateLogError,
  type PrivateLogFile,
} from './private-log-file.js';

export interface PrivateLogHealth {
  state: PrivateLogState;
  code?: PrivateLogCode;
  queued: number;
  synced: number;
  dropped: number;
  closed: boolean;
}

export interface PrivateLogOptions {
  fileBytes?: number;
  recordBytes?: number;
  pendingRecords?: number;
  drainMs?: number;
}

export async function createPrivateLog(
  directory: string,
  options: PrivateLogOptions = {},
) {
  const limits = { ...PRIVATE_LOG_LIMITS, ...options };
  for (const value of [
    limits.fileBytes,
    limits.recordBytes,
    limits.pendingRecords,
    limits.drainMs,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Invalid private log limit.');
  const queue: string[] = [];
  let file: PrivateLogFile | undefined;
  let running: Promise<void> | undefined;
  let failure: PrivateLogCode | undefined;
  let poisoned = false,
    closed = false,
    accepting = true,
    warned = false,
    inFlight = false;
  let closing: Promise<PrivateLogHealth> | undefined;
  let reservedBytes = 0,
    synced = 0,
    dropped = 0;
  const degrade = (code: PrivateLogCode) => {
    failure = code;
    if (!warned) {
      warned = true;
      try {
        console.error(PRIVATE_LOG_WARNING);
      } catch {
        /* Logging is observational. */
      }
    }
  };
  const health = (): PrivateLogHealth => ({
    state: failure
      ? PRIVATE_LOG_STATES.DEGRADED
      : closed
        ? PRIVATE_LOG_STATES.CLOSED
        : PRIVATE_LOG_STATES.READY,
    code: failure,
    queued: queue.length + (inFlight ? 1 : 0),
    synced,
    dropped,
    closed,
  });
  try {
    file = await openPrivateLogFile(directory);
  } catch (error) {
    poisoned = true;
    degrade(
      error instanceof PrivateLogError
        ? error.code
        : PRIVATE_LOG_CODES.PERSISTENCE_FAILED,
    );
  }
  const pump = async () => {
    while (queue.length && !poisoned) {
      const line = queue.shift()!;
      inFlight = true;
      try {
        await file!.append(line);
        synced++;
      } catch (error) {
        poisoned = true;
        dropped += queue.length + 1;
        queue.splice(0);
        degrade(
          error instanceof PrivateLogError
            ? error.code
            : PRIVATE_LOG_CODES.PERSISTENCE_FAILED,
        );
      } finally {
        inFlight = false;
      }
    }
  };
  const start = () => {
    if (!running && queue.length && !poisoned)
      running = Promise.resolve()
        .then(pump)
        .finally(() => {
          running = undefined;
          start();
        });
  };
  const write = (record: object) => {
    if (!accepting || poisoned) {
      dropped++;
      return;
    }
    try {
      const line = JSON.stringify(record) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > limits.recordBytes) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.RECORD_LIMIT);
        return;
      }
      if (reservedBytes + bytes > limits.fileBytes) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.STORAGE_LIMIT);
        return;
      }
      if (queue.length + (inFlight ? 1 : 0) >= limits.pendingRecords) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.QUEUE_FULL);
        return;
      }
      reservedBytes += bytes;
      queue.push(line);
      start();
    } catch {
      dropped++;
      degrade(PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
    }
  };
  const flush = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (running) await running;
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            degrade(PRIVATE_LOG_CODES.DRAIN_TIMEOUT);
            resolve();
          }, limits.drainMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return health();
  };
  return {
    write,
    health,
    flush,
    path: file?.path,
    close(): Promise<PrivateLogHealth> {
      if (closing) return closing;
      closing = (async () => {
        accepting = false;
        await flush();
        const finish = async () => {
          try {
            await file?.close();
          } catch {
            degrade(PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
          }
          closed = true;
        };
        if (running) void running.then(finish);
        else await finish();
        return health();
      })();
      return closing;
    },
  };
}
