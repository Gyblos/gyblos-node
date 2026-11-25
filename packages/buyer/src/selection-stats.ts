// Persists bounded buyer-local selection metadata with private modes and atomic replacement.
// Never records prompts, quotes, identities from payment payloads or authorization state.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import type { SellerStats } from '@gyblos/core/seller-selection';
import { assertRoleHome } from '@gyblos/node/home';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { BUYER_SELECTION, BUYER_SELECTION_CODES } from './constants';
import { BuyerSelectionError } from './selection-config';

export interface LocalSellerStats extends SellerStats {
  quotedWaitMs: number | null;
  observedWaitMs: number | null;
}
function nullableNumber(value: unknown) {
  return value === null ? null : controlInteger(value);
}
function parseStats(value: unknown): LocalSellerStats {
  const row = controlObject(value, [
    'successes',
    'failures',
    'latencyMs',
    'waitAccuracy',
    'cooldownUntil',
    'quotedWaitMs',
    'observedWaitMs',
  ]);
  const accuracy = row.waitAccuracy;
  if (
    accuracy !== null &&
    (typeof accuracy !== 'number' ||
      !Number.isFinite(accuracy) ||
      accuracy < 0 ||
      accuracy > 1)
  )
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  return {
    successes: controlInteger(row.successes),
    failures: controlInteger(row.failures),
    latencyMs: nullableNumber(row.latencyMs),
    waitAccuracy: accuracy,
    cooldownUntil: nullableNumber(row.cooldownUntil),
    quotedWaitMs: nullableNumber(row.quotedWaitMs),
    observedWaitMs: nullableNumber(row.observedWaitMs),
  };
}
// A cooldown saved by an earlier run lasts at most the base cooldown from now: a restart starts the
// backoff count over (selection-backoff.ts), so it must not keep a long one.
function loadedStats(stats: LocalSellerStats, now = Date.now()) {
  const limit = now + BUYER_SELECTION.cooldownMs;
  return stats.cooldownUntil !== null && stats.cooldownUntil > limit
    ? { ...stats, cooldownUntil: limit }
    : stats;
}
export async function selectionStats(environment: HomeEnvironment) {
  await assertRoleHome(P2P_ROLES.BUYER, environment);
  const directory = homeLayout(environment).roles.buyer;
  const path = join(directory, BUYER_SELECTION.statsFile);
  const rows = new Map<string, LocalSellerStats>();
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > BUYER_SELECTION.maxConfigBytes
    )
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    const file = await open(path, 'r');
    try {
      const parsed: unknown = JSON.parse(await file.readFile('utf8'));
      const value = controlObject(parsed, ['rows']);
      if (
        !Array.isArray(value.rows) ||
        value.rows.length > BUYER_SELECTION.maxSellers
      )
        throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
      for (const entry of value.rows) {
        const row = controlObject(entry, ['nodeId', 'stats']);
        rows.set(controlHex(row.nodeId), loadedStats(parseStats(row.stats)));
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  }
  return {
    rows,
    async save() {
      await assertRoleHome(P2P_ROLES.BUYER, environment);
      await mkdir(directory, {
        recursive: true,
        mode: FILE_MODES.privateDirectory,
      });
      await chmod(directory, FILE_MODES.privateDirectory);
      const temporary = join(
        directory,
        `${BUYER_SELECTION.statsFile}.${randomUUID()}.tmp`,
      );
      const file = await open(temporary, 'wx', FILE_MODES.privateFile);
      try {
        await file.writeFile(
          JSON.stringify({
            rows: [...rows].map(([nodeId, stats]) => ({ nodeId, stats })),
          }),
        );
        await file.close();
        await rename(temporary, path);
      } finally {
        await file.close();
        await rm(temporary, { force: true });
      }
    },
  };
}

// A seller that failed while executing counts a failure, so it weighs less next time; it is not cooled
// down, since a seller that is really gone already is at its next quote, and the only seller of a buyer
// stays reachable after one failed answer.
export function recordExecutionFailure(
  stats: Map<string, LocalSellerStats>,
  nodeId: string,
) {
  const prior = stats.get(nodeId);
  stats.set(nodeId, {
    successes: prior?.successes ?? 0,
    failures: (prior?.failures ?? 0) + 1,
    // A seller first seen failing has no latency yet, not the best one.
    latencyMs: prior?.latencyMs ?? null,
    waitAccuracy: prior?.waitAccuracy ?? null,
    cooldownUntil: prior?.cooldownUntil ?? null,
    quotedWaitMs: prior?.quotedWaitMs ?? null,
    observedWaitMs: prior?.observedWaitMs ?? null,
  });
}

// Apply this selection's deltas to current statistics, preserving concurrent execution updates.
export function mergeSelectionStats(
  live: Map<string, LocalSellerStats>,
  before: ReadonlyMap<string, LocalSellerStats>,
  selected: ReadonlyMap<string, LocalSellerStats>,
) {
  for (const [nodeId, row] of selected) {
    const prior = before.get(nodeId);
    if (prior === row) continue;
    const current = live.get(nodeId);
    const metadata = <
      Key extends keyof Omit<LocalSellerStats, 'successes' | 'failures'>,
    >(
      key: Key,
    ) =>
      current?.[key] !== prior?.[key] ? (current?.[key] ?? null) : row[key];
    live.set(nodeId, {
      successes:
        (current?.successes ?? 0) + row.successes - (prior?.successes ?? 0),
      failures:
        (current?.failures ?? 0) + row.failures - (prior?.failures ?? 0),
      latencyMs: metadata('latencyMs'),
      waitAccuracy: metadata('waitAccuracy'),
      cooldownUntil: metadata('cooldownUntil'),
      quotedWaitMs: metadata('quotedWaitMs'),
      observedWaitMs: metadata('observedWaitMs'),
    });
  }
}
