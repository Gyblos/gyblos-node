// Owns offline private log rotation cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import {
  PRIVATE_LOG_CODES,
  PRIVATE_LOG_STATES,
} from '@gyblos/runtime/constants';

import {
  createPrivateLog,
  diagnosticDirectory,
  rm,
} from './facilitator-diagnostic-fixture.js';
import {
  directorySnapshot,
  PRIVATE_LOG_PLATFORM_SKIP,
  seedJournal,
  SETTLED_AGE_SECONDS,
  slotName,
  withLogIo,
} from './private-log-fixture.js';

const OPTIONS = { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP };
// `{"index":N}\n` is 12 bytes, so each rotated file holds exactly two records.
const FILE_BYTES = 24;

async function inTemporaryDirectory(run: (directory: string) => Promise<void>) {
  const directory = await diagnosticDirectory();
  try {
    await withLogIo(() => run(directory));
  } finally {
    await rm(directory, { recursive: true });
  }
}

async function journalBytes(directory: string) {
  let total = 0;
  for (const name of await readdir(directory))
    total += (await lstat(join(directory, name))).size;
  return total;
}

async function indexes(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { index: number }).index);
}

export function registerPrivateLogRotationCases() {
  void test(
    'a record larger than one file is dropped without rotating',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        const fileBytes = 8;
        const log = await createPrivateLog(directory, {
          fileBytes,
          recordBytes: 64,
        });
        log.write({ ok: true });
        const health = await log.close();
        assert.equal(health.code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
        assert.equal(health.synced, 0);
        assert.equal(health.dropped, 1);
        assert.equal(health.rotations, 0);
        for (const name of await readdir(directory))
          assert.ok((await lstat(join(directory, name))).size <= fileBytes);
      }),
  );
  void test(
    'budget exhaustion rotates a bounded number of times, then drops',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        const maxRotations = 2;
        const log = await createPrivateLog(directory, {
          fileBytes: FILE_BYTES,
          maxRotations,
        });
        for (let index = 0; index < 4; index++) {
          log.write({ index });
          await log.flush();
        }
        assert.equal(log.health().state, PRIVATE_LOG_STATES.READY);
        assert.equal(log.health().rotations, 1);
        for (let index = 4; index < 10; index++) {
          log.write({ index });
          await log.flush();
        }
        const health = await log.close();
        assert.equal(health.code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
        assert.equal(health.rotations, maxRotations);
        assert.equal(health.synced, 6);
        assert.equal(health.dropped, 4);
        assert.equal(log.path, join(directory, slotName(2)));
        const files = (await readdir(directory)).sort();
        assert.deepEqual(files, [slotName(0), slotName(1), slotName(2)]);
        const rows = [];
        for (const name of files) {
          assert.ok((await lstat(join(directory, name))).size <= FILE_BYTES);
          rows.push(...(await indexes(join(directory, name))));
        }
        assert.deepEqual(rows, [0, 1, 2, 3, 4, 5]);
        assert.ok(
          (await journalBytes(directory)) <= (1 + maxRotations) * FILE_BYTES,
        );
      }),
  );
  void test(
    'rotation reclaims the oldest settled journal within the file cap',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        for (let index = 1; index < PRIVATE_LOG_LIMITS.maxFiles; index++)
          await seedJournal(
            directory,
            slotName(index),
            SETTLED_AGE_SECONDS + (16 - index) * 60,
          );
        const before = await directorySnapshot(directory);
        const log = await createPrivateLog(directory, {
          fileBytes: FILE_BYTES,
          maxRotations: 1,
        });
        assert.equal(log.path, join(directory, slotName(0)));
        for (let index = 0; index < 4; index++) log.write({ index });
        const health = await log.close();
        assert.equal(health.code, undefined);
        assert.equal(health.synced, 4);
        // The just-closed slot 0 is recent, so slot 1 is reclaimed instead.
        assert.equal(log.path, join(directory, slotName(1)));
        assert.deepEqual(await indexes(join(directory, slotName(0))), [0, 1]);
        assert.deepEqual(await indexes(join(directory, slotName(1))), [2, 3]);
        const after = await directorySnapshot(directory);
        for (let index = 2; index < PRIVATE_LOG_LIMITS.maxFiles; index++)
          assert.equal(after[slotName(index)], before[slotName(index)]);
        assert.equal(Object.keys(after).length, PRIVATE_LOG_LIMITS.maxFiles);
        assert.ok(
          (await journalBytes(directory)) <=
            PRIVATE_LOG_LIMITS.maxFiles * FILE_BYTES,
        );
      }),
  );
  void test(
    'a pending rotation occupies a queue slot and never exceeds the bound',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        const log = await createPrivateLog(directory, {
          fileBytes: FILE_BYTES,
          pendingRecords: 3,
        });
        for (let index = 0; index < 3; index++) log.write({ index });
        assert.equal(log.health().code, PRIVATE_LOG_CODES.QUEUE_FULL);
        assert.ok(log.health().queued <= 3);
        const health = await log.close();
        assert.equal(health.synced, 2);
        assert.equal(health.dropped, 1);
        assert.equal(health.rotations, 0);
        assert.deepEqual(await readdir(directory), [slotName(0)]);
      }),
  );
}
