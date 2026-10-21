import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lutimes,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import { PRIVATE_LOG_CODES } from '@gyblos/runtime/constants';

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
  withFsPatch,
  withLogIo,
} from './private-log-fixture.js';

const OPTIONS = { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP };

async function seedPool(directory: string, age: (index: number) => number) {
  for (let index = 0; index < PRIVATE_LOG_LIMITS.maxFiles; index++)
    await seedJournal(directory, slotName(index), age(index));
}

function withoutEntry(entries: Record<string, string>, name: string) {
  return Object.fromEntries(
    Object.entries(entries).filter(([entry]) => entry !== name),
  );
}

async function quarantines(directory: string) {
  return (await readdir(directory)).filter((name) =>
    name.endsWith(PRIVATE_LOG_LIMITS.quarantineSuffix),
  );
}

async function inTemporaryDirectory(run: (directory: string) => Promise<void>) {
  const directory = await diagnosticDirectory();
  try {
    await withLogIo(() => run(directory));
  } finally {
    await rm(directory, { recursive: true });
  }
}

export function registerPrivateLogReclaimCases() {
  test(
    'slot limit reclaims only the least recently appended own journal',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        // Oldest is slot 8, then slot 7: order follows mtime, not slot index.
        await seedPool(
          directory,
          (index) => SETTLED_AGE_SECONDS + ((index + 7) % 16) * 60,
        );
        const before = await directorySnapshot(directory);
        const log = await createPrivateLog(directory);
        assert.equal(log.health().code, undefined);
        assert.equal(log.path, join(directory, slotName(8)));
        log.write({ synthetic: 'after reclamation' });
        await log.close();
        assert.equal(log.health().synced, 1);
        const after = await directorySnapshot(directory);
        assert.deepEqual(
          withoutEntry(after, slotName(8)),
          withoutEntry(before, slotName(8)),
        );
        const restarted = await createPrivateLog(directory);
        await restarted.close();
        assert.equal(restarted.path, join(directory, slotName(7)));
        assert.equal(
          (await readdir(directory)).length,
          PRIVATE_LOG_LIMITS.maxFiles,
        );
        assert.match(await readFile(log.path!, 'utf8'), /after reclamation/);
      }),
  );
  test(
    'reclamation never removes linked, foreign, unsafe or legacy entries',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (root) => {
        const directory = join(root, 'log');
        const outside = join(root, 'outside');
        await mkdir(directory, { mode: 0o700 });
        await mkdir(outside, { mode: 0o700 });
        const ancient = SETTLED_AGE_SECONDS * 10;
        // A legacy journal shrinks the pool to slots 0..14 and is never removed.
        await seedJournal(directory, slotName('legacy'), ancient);
        for (const foreign of [
          'other-0.jsonl',
          slotName(0) + '.bak',
          '.' + slotName(1),
          PRIVATE_LOG_LIMITS.filenamePrefix + '1.log',
        ])
          await seedJournal(directory, foreign, ancient);
        const target = await seedJournal(outside, slotName(0), ancient);
        await symlink(target, join(directory, slotName(0)));
        const old = new Date(Date.now() - ancient * 1000);
        await lutimes(join(directory, slotName(0)), old, old);
        const linked = await seedJournal(directory, slotName(1), ancient);
        await link(linked, join(directory, 'alias'));
        await chmod(await seedJournal(directory, slotName(2), ancient), 0o644);
        // A non-regular entry with the journal's private mode.
        await mkdir(join(directory, slotName(3)), { mode: 0o700 });
        await utimes(join(directory, slotName(3)), old, old);
        await chmod(join(directory, slotName(3)), 0o600);
        await seedJournal(directory, slotName(4), ancient);
        for (let index = 5; index < PRIVATE_LOG_LIMITS.maxFiles - 1; index++)
          await seedJournal(
            directory,
            slotName(index),
            SETTLED_AGE_SECONDS + (16 - index) * 60,
          );
        const before = await directorySnapshot(directory);
        const outsideBefore = await directorySnapshot(outside);
        // Slot 4 simulates a journal owned by another uid.
        const log = await withFsPatch(
          'lstat',
          (original) =>
            (async (...input: Parameters<typeof original>) => {
              const info = await original(...input);
              return String(input[0]).endsWith(slotName(4))
                ? Object.assign(
                    Object.create(Object.getPrototypeOf(info) as object),
                    info,
                    { uid: Number(info.uid) + 1 },
                  )
                : info;
            }) as typeof original,
          () => createPrivateLog(directory),
        );
        await log.close();
        assert.equal(log.health().code, undefined);
        assert.equal(log.path, join(directory, slotName(5)));
        assert.deepEqual(
          withoutEntry(await directorySnapshot(directory), slotName(5)),
          withoutEntry(before, slotName(5)),
        );
        assert.deepEqual(await directorySnapshot(outside), outsideBefore);
        await chmod(join(directory, slotName(3)), 0o700);
      }),
  );
  test(
    'reclamation fails closed for recent journals and journals open here',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        const open = await createPrivateLog(directory);
        const old = new Date(Date.now() - SETTLED_AGE_SECONDS * 1000);
        await utimes(open.path!, old, old);
        for (let index = 1; index < PRIVATE_LOG_LIMITS.maxFiles; index++)
          await seedJournal(directory, slotName(index), 0);
        const before = await directorySnapshot(directory);
        const refused = await createPrivateLog(directory);
        assert.equal(refused.health().code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
        assert.deepEqual(await directorySnapshot(directory), before);
        open.write({ synthetic: 'still owned' });
        await open.close();
        await refused.close();
        assert.equal(open.health().synced, 1);
      }),
  );
  test(
    'a concurrently vanished oldest journal frees its slot without other deletions',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        await seedPool(
          directory,
          (index) => SETTLED_AGE_SECONDS + (index === 3 ? 3600 : index),
        );
        const before = await directorySnapshot(directory);
        const log = await withFsPatch(
          'rename',
          (original) =>
            (async (source, destination) => {
              // Another process reclaims the same journal first.
              if (String(source).endsWith(slotName(3)))
                await original(source, join(directory, 'taken-elsewhere'));
              return original(source, destination);
            }) as typeof original,
          () => createPrivateLog(directory),
        );
        await log.close();
        assert.equal(log.health().code, undefined);
        assert.equal(log.path, join(directory, slotName(3)));
        const after = await directorySnapshot(directory);
        assert.deepEqual(
          withoutEntry(withoutEntry(after, slotName(3)), 'taken-elsewhere'),
          withoutEntry(before, slotName(3)),
        );
        assert.deepEqual(await quarantines(directory), []);
      }),
  );
  test(
    'a journal replaced during reclamation is restored and storage fails closed',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        await seedPool(
          directory,
          (index) => SETTLED_AGE_SECONDS + (index === 3 ? 3600 : index),
        );
        const before = await directorySnapshot(directory);
        const oldest = join(directory, slotName(3));
        const log = await withFsPatch(
          'rename',
          (original) =>
            (async (source, destination) => {
              // Another process reclaimed and recreated this slot meanwhile.
              if (String(source) === oldest) {
                await original(source, join(directory, 'taken-elsewhere'));
                await writeFile(oldest, 'replacement\n', { mode: 0o600 });
              }
              return original(source, destination);
            }) as typeof original,
          () => createPrivateLog(directory),
        );
        await log.close();
        assert.equal(log.health().code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
        assert.equal(await readFile(oldest, 'utf8'), 'replacement\n');
        assert.deepEqual(
          withoutEntry(
            withoutEntry(await directorySnapshot(directory), slotName(3)),
            'taken-elsewhere',
          ),
          withoutEntry(before, slotName(3)),
        );
        assert.deepEqual(await quarantines(directory), []);
      }),
  );
  test(
    'settled own quarantine leftovers are removed; recent ones are kept',
    OPTIONS,
    () =>
      inTemporaryDirectory(async (directory) => {
        await seedPool(directory, (index) => SETTLED_AGE_SECONDS + index);
        const leftover =
          PRIVATE_LOG_LIMITS.filenamePrefix +
          PRIVATE_LOG_LIMITS.quarantineInfix +
          'crashed' +
          PRIVATE_LOG_LIMITS.quarantineSuffix;
        await seedJournal(directory, leftover, SETTLED_AGE_SECONDS);
        const first = await createPrivateLog(directory);
        await first.close();
        assert.deepEqual(await quarantines(directory), [leftover]);
        await setTimeout(5);
        const second = await createPrivateLog(directory, {
          reclaimMinAgeMs: 1,
        });
        await second.close();
        assert.equal(second.health().code, undefined);
        assert.deepEqual(await quarantines(directory), []);
        assert.equal(
          (await readdir(directory)).length,
          PRIVATE_LOG_LIMITS.maxFiles,
        );
      }),
  );
}
