// Persists bounded buyer-local selection metadata with private modes and atomic replacement.
// Never records prompts, quotes, identities from payment payloads or authorization state.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import type { SellerStats } from '@gyblos/core/seller-selection';
import { P2P_ROLES } from '@gyblos/node/constants';
import { assertRoleHome } from '@gyblos/node/home';
import {
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { BUYER_SELECTION, BUYER_SELECTION_CODES } from './constants.js';
import { BuyerSelectionError } from './selection-config.js';

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
        rows.set(controlHex(row.nodeId), parseStats(row.stats));
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
