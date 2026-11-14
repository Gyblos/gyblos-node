// Atomic buyer-wide reservations under one private process lock; failed writes poison the handle.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  batchPoolChannelPaths,
  type BatchPoolPaths,
} from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlArray,
  controlAtomic,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  checkPrivateDirectory,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { batchOpeningAbsent } from './batch-opening-proof';
import type { PoolRecord, PoolRow } from './batch-pool-types';
import { termsFor } from './batch-session-checks';
import { initialRecord } from './batch-session-common';
import { readBatchRecord } from './batch-session-state';
import { BATCH_POOL_VERSION } from './constants';

function parse(value: unknown): PoolRecord {
  const row = controlObject(value, ['version', 'entries']);
  if (row.version !== BATCH_POOL_VERSION) return sessionFail();
  const keys = new Set<string>();
  const entries = controlArray(
    row.entries,
    BATCH_SESSION_DEFAULTS.maxSessions,
  ).map((value) => {
    const entry = controlObject(value, [
      'terms',
      'legacy',
      'ready',
      'requestId',
      'uncertain',
      'refundedAtomic',
    ]);
    const terms = termsFor(entry.terms);
    if (
      typeof entry.legacy !== 'boolean' ||
      typeof entry.ready !== 'boolean' ||
      typeof entry.uncertain !== 'boolean' ||
      keys.has(terms.sellerNodeId)
    )
      return sessionFail();
    keys.add(terms.sellerNodeId);
    const refundedAtomic = controlAtomic(entry.refundedAtomic);
    if (
      (!entry.ready &&
        (entry.legacy ||
          entry.uncertain ||
          entry.requestId !== null ||
          refundedAtomic !== '0')) ||
      (entry.requestId !== null && !entry.uncertain)
    )
      return sessionFail();
    if (BigInt(refundedAtomic) > BigInt(terms.depositAtomic))
      return sessionFail();
    return {
      terms,
      legacy: entry.legacy,
      ready: entry.ready,
      uncertain: entry.uncertain,
      requestId:
        entry.requestId === null
          ? null
          : controlHex(entry.requestId, PAYMENT_SESSION.requestIdBytes),
      refundedAtomic,
    };
  });
  const first = entries[0]?.terms;
  if (
    first &&
    entries.some(
      (entry) =>
        entry.terms.buyer !== first.buyer ||
        entry.terms.buyerNodeId !== first.buyerNodeId ||
        entry.terms.network !== first.network ||
        entry.terms.mint !== first.mint,
    )
  )
    return sessionFail();
  if (entries.filter((entry) => entry.legacy).length > 1) return sessionFail();
  return { version: BATCH_POOL_VERSION, entries };
}
export const poolPaths = (paths: BatchPoolPaths, row: PoolRow) =>
  row.legacy
    ? paths.legacy
    : batchPoolChannelPaths(paths, row.terms.sellerNodeId);
export async function readPool(
  paths: BatchPoolPaths,
  includeLegacy = true,
): Promise<PoolRecord> {
  if (!(await checkPrivateDirectory(paths.directory)))
    return { version: BATCH_POOL_VERSION, entries: [] };
  const raw = await readPrivateFile(
    paths.state,
    BATCH_SESSION_DEFAULTS.poolBytes,
  );
  const legacy = await readBatchRecord(paths.legacy);
  if (raw === undefined) {
    if (!includeLegacy) return { version: BATCH_POOL_VERSION, entries: [] };
    if (!legacy) return { version: BATCH_POOL_VERSION, entries: [] };
    const pending = Object.entries(legacy.requests).find(
      ([, request]) => !request.accepted,
    );
    return {
      version: BATCH_POOL_VERSION,
      entries: [
        {
          terms: legacy.terms,
          legacy: true,
          ready: true,
          uncertain:
            !batchOpeningAbsent(legacy) &&
            (legacy.state === SESSION_STATES.OPENING ||
              (legacy.opening !== null &&
                Object.keys(legacy.requests).length === 0) ||
              pending !== undefined),
          requestId: batchOpeningAbsent(legacy) ? null : (pending?.[0] ?? null),
          refundedAtomic: legacy.settlement?.refundedAtomic ?? '0',
        },
      ],
    };
  }
  if (WINDOWS) return sessionFail(SESSION_CODES.UNAVAILABLE);
  const record = parse(JSON.parse(raw));
  const known = record.entries.find((entry) => entry.legacy);
  if (
    legacy &&
    (!known || canonicalJson(known.terms) !== canonicalJson(legacy.terms))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (known && !legacy) return sessionFail(SESSION_CODES.UNVERIFIED);
  return record;
}
export async function poolChild(paths: BatchPoolPaths, row: PoolRow) {
  const record = await readBatchRecord(poolPaths(paths, row));
  if (!record || canonicalJson(record.terms) !== canonicalJson(row.terms))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (
    row.refundedAtomic !== '0' &&
    (record.state !== SESSION_STATES.CLOSED ||
      record.settlement?.refundedAtomic !== row.refundedAtomic)
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return record;
}
async function seed(paths: BatchPoolPaths, row: PoolRow, now: number) {
  const pathsFor = poolPaths(paths, row);
  const found = await readBatchRecord(pathsFor);
  if (found) {
    if (
      canonicalJson(found.terms) !== canonicalJson(row.terms) ||
      found.hints !== null ||
      found.opening !== null ||
      Object.keys(found.requests).length > 0
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    return;
  }
  await ensurePrivateDirectory(pathsFor.directory);
  await writePrivateFile(
    pathsFor.state,
    JSON.stringify(initialRecord(row.terms, now)),
    BATCH_SESSION_DEFAULTS.stateBytes,
    { exclusive: true },
  );
}
export async function openPoolStore(paths: BatchPoolPaths, now: () => number) {
  if (WINDOWS) return sessionFail(SESSION_CODES.UNAVAILABLE);
  await ensurePrivateDirectory(paths.directory);
  const lock = await acquireProcessLock(paths.lock);
  let current: PoolRecord;
  let poisoned = false;
  let disposed = false;
  try {
    current = await readPool(paths);
  } catch (error) {
    await lock.release();
    throw error;
  }
  const update = async (change: (next: PoolRecord) => void) => {
    if (poisoned || disposed) return sessionFail(SESSION_CODES.UNAVAILABLE);
    await lock.verify();
    const next = structuredClone(current);
    change(next);
    const checked = parse(next);
    try {
      await writePrivateFile(
        paths.state,
        JSON.stringify(checked),
        BATCH_SESSION_DEFAULTS.poolBytes,
      );
      current = checked;
    } catch {
      poisoned = true;
      return sessionFail(SESSION_CODES.UNAVAILABLE);
    }
  };
  const prepare = async (row: PoolRow) => {
    if (row.ready) {
      await poolChild(paths, row);
      return;
    }
    await seed(paths, row, now());
    await update((next) => {
      next.entries.find(
        (entry) => entry.terms.sellerNodeId === row.terms.sellerNodeId,
      )!.ready = true;
    });
  };
  try {
    for (const row of current.entries) await prepare(row);
  } catch (error) {
    await lock.release();
    throw error;
  }
  return {
    read: () => {
      if (poisoned || disposed) return sessionFail(SESSION_CODES.UNAVAILABLE);
      return structuredClone(current);
    },
    update,
    prepare,
    async dispose() {
      disposed = true;
      await lock.release();
    },
  };
}
