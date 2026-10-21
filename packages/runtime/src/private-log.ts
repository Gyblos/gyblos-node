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

// Queue marker: close the exhausted file and reserve a fresh one in order.
const ROTATE = Symbol('rotate');

export interface PrivateLogHealth {
  state: PrivateLogState;
  code?: PrivateLogCode;
  queued: number;
  synced: number;
  dropped: number;
  rotations: number;
  closed: boolean;
}

export interface PrivateLogOptions {
  fileBytes?: number;
  recordBytes?: number;
  pendingRecords?: number;
  drainMs?: number;
  maxRotations?: number;
  reclaimMinAgeMs?: number;
}

function storageCode(error: unknown): PrivateLogCode {
  try {
    if (error instanceof PrivateLogError) {
      const candidate = error.code;
      const canonical = Object.values(PRIVATE_LOG_CODES).find(
        (code) => code === candidate,
      );
      if (canonical) return canonical;
    }
  } catch {
    // Hostile error prototypes/getters never become diagnostic data.
  }
  return PRIVATE_LOG_CODES.PERSISTENCE_FAILED;
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
  for (const value of [limits.maxRotations, limits.reclaimMinAgeMs])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid private log limit.');
  const queue: (string | typeof ROTATE)[] = [];
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
    dropped = 0,
    rotations = 0;
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
    rotations,
    closed,
  });
  const reopen = () =>
    openPrivateLogFile(directory, { reclaimMinAgeMs: limits.reclaimMinAgeMs });
  try {
    file = await reopen();
  } catch (error) {
    poisoned = true;
    degrade(storageCode(error));
  }
  const pump = async () => {
    while (queue.length && !poisoned) {
      const line = queue.shift()!;
      inFlight = true;
      try {
        if (line === ROTATE) {
          const exhausted = file!;
          file = undefined;
          await exhausted.close();
          file = await reopen();
        } else {
          await file!.append(line);
          synced++;
        }
      } catch (error) {
        poisoned = true;
        dropped += queue.filter((entry) => entry !== ROTATE).length;
        if (line !== ROTATE) dropped++;
        queue.splice(0);
        degrade(storageCode(error));
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
      const serialized = JSON.stringify(record);
      if (typeof serialized !== 'string') {
        dropped++;
        degrade(PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
        return;
      }
      const line = serialized + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > limits.recordBytes) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.RECORD_LIMIT);
        return;
      }
      // A record that cannot fit in one file would exceed its hard budget
      // even after rotation.
      if (bytes > limits.fileBytes) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.STORAGE_LIMIT);
        return;
      }
      const rotate = reservedBytes + bytes > limits.fileBytes;
      if (rotate && rotations >= limits.maxRotations) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.STORAGE_LIMIT);
        return;
      }
      // A rotation marker occupies one queue slot, keeping the queue bound.
      if (
        queue.length + (inFlight ? 1 : 0) + (rotate ? 1 : 0) >=
        limits.pendingRecords
      ) {
        dropped++;
        degrade(PRIVATE_LOG_CODES.QUEUE_FULL);
        return;
      }
      if (rotate) {
        rotations++;
        reservedBytes = 0;
        queue.push(ROTATE);
      }
      reservedBytes += bytes;
      queue.push(line);
      start();
    } catch {
      dropped++;
      degrade(PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
    }
  };
  const drain = async () => {
    while (running) await running;
  };
  const bounded = async (work: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
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
  };
  const flush = async () => {
    await bounded(drain());
    return health();
  };

  return {
    write,
    health,
    flush,
    get path() {
      return file?.path;
    },
    close(): Promise<PrivateLogHealth> {
      if (closing) return closing;
      accepting = false;
      const finish = async () => {
        try {
          await drain();
          await file?.close();
          closed = true;
        } catch {
          degrade(PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
        }
      };
      closing = (async () => {
        await bounded(finish());
        return health();
      })();
      return closing;
    },
  };
}
