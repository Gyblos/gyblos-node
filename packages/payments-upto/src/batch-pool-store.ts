// Atomic buyer-wide reservations under one private process lock; failed writes poison the handle.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  batchPoolChannelPaths,
  type BatchPoolPaths,
} from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlAddress,
  controlArray,
  controlAtomic,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  PaymentSessionError,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  checkPrivateDirectory,
  ensurePrivatePaymentPaths,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { batchOpeningAbsent, replaceableOpening } from './batch-opening-proof';
import type { PoolRecord, PoolRow } from './batch-pool-types';
import { termsFor } from './batch-session-checks';
import { initialRecord } from './batch-session-common';
import { sameBatchParties } from './batch-session-history';
import { withBatchState } from './batch-session-io';
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
      'replacing',
      'requestId',
      'uncertain',
      'refundedAtomic',
    ]);
    const terms = termsFor(entry.terms);
    if (
      typeof entry.legacy !== 'boolean' ||
      typeof entry.ready !== 'boolean' ||
      typeof entry.uncertain !== 'boolean' ||
      (entry.ready && entry.replacing !== undefined) ||
      (!entry.ready && entry.legacy && entry.replacing === undefined) ||
      keys.has(terms.sellerNodeId)
    )
      return sessionFail();
    keys.add(terms.sellerNodeId);
    const refundedAtomic = controlAtomic(entry.refundedAtomic);
    if (
      (!entry.ready &&
        (entry.uncertain ||
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
      ...(entry.replacing === undefined
        ? {}
        : { replacing: controlAddress(entry.replacing) }),
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
  await ensurePrivatePaymentPaths(paths);
  const raw = await withBatchState(paths, () =>
    readPrivateFile(paths.state, BATCH_SESSION_DEFAULTS.poolBytes),
  );
  const legacy = await readBatchRecord(paths.legacy);
  // Pool generation accounting is separate; never silently discard a renewed root's historical spend.
  if (
    legacy?.history?.some((entry) => !replaceableOpening(entry)) &&
    (raw !== undefined || includeLegacy)
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
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
  const record = parse(JSON.parse(raw));
  const known = record.entries.find((entry) => entry.legacy);
  if (
    legacy &&
    (!known ||
      (canonicalJson(known.terms) !== canonicalJson(legacy.terms) &&
        (known.ready ||
          known.replacing !== legacy.channelId ||
          !replaceableOpening(legacy))))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (known && !legacy) return sessionFail(SESSION_CODES.UNVERIFIED);
  return record;
}
export async function poolChild(paths: BatchPoolPaths, row: PoolRow) {
  const record = await readBatchRecord(poolPaths(paths, row));
  if (record?.history?.some((entry) => !replaceableOpening(entry)))
    return sessionFail(SESSION_CODES.UNVERIFIED);
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
    // A crash before the child rotated leaves the original proof intact. Restore its row.
    if (
      row.replacing === found.channelId &&
      replaceableOpening(found) &&
      canonicalJson(found.terms) !== canonicalJson(row.terms) &&
      sameBatchParties(found.terms, row.terms)
    )
      return found;
    if (
      canonicalJson(found.terms) !== canonicalJson(row.terms) ||
      (row.replacing !== undefined &&
        found.history?.at(-1)?.channelId !== row.replacing) ||
      found.hints !== null ||
      found.opening !== null ||
      Object.keys(found.requests).length > 0
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    return;
  }
  if (row.replacing !== undefined) return sessionFail(SESSION_CODES.UNVERIFIED);
  await ensurePrivatePaymentPaths(pathsFor);
  await withBatchState(pathsFor, () =>
    writePrivateFile(
      pathsFor.state,
      JSON.stringify(initialRecord(row.terms, now)),
      BATCH_SESSION_DEFAULTS.stateBytes,
      { exclusive: true },
    ),
  );
}
export async function openPoolStore(paths: BatchPoolPaths, now: () => number) {
  await ensurePrivatePaymentPaths(paths);
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
      await withBatchState(paths, () =>
        writePrivateFile(
          paths.state,
          JSON.stringify(checked),
          BATCH_SESSION_DEFAULTS.poolBytes,
        ),
      );
      current = checked;
    } catch (error) {
      // Queue pressure refuses before publication; only attempted/uncertain writes poison authority.
      if (
        error instanceof PaymentSessionError &&
        error.code === SESSION_CODES.BUSY
      )
        throw error;
      poisoned = true;
      return sessionFail(SESSION_CODES.UNAVAILABLE);
    }
  };
  const prepare = async (row: PoolRow) => {
    if (row.ready) {
      await poolChild(paths, row);
      return;
    }
    const previous = await seed(paths, row, now());
    await update((next) => {
      const entry = next.entries.find(
        (entry) => entry.terms.sellerNodeId === row.terms.sellerNodeId,
      )!;
      entry.ready = true;
      delete entry.replacing;
      if (previous) {
        entry.terms = previous.terms;
        entry.refundedAtomic = previous.settlement?.refundedAtomic ?? '0';
      }
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
