// Private file primitives and the process lock: owner-only directories without symlinked
// components, bounded no-follow reads, atomic writes, and a lock only a dead owner can lose.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PRIVATE_FILE_CODES } from '@gyblos/runtime/constants';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  PrivateFileError,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

const MAX = 1024;

const refused = (error: unknown) =>
  error instanceof PrivateFileError &&
  error.code === PRIVATE_FILE_CODES.UNAVAILABLE;

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-private-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('directories and files are created owner-only and written atomically', () =>
  withRoot(async (root) => {
    const directory = join(root, 'a', 'b');
    await ensurePrivateDirectory(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const file = join(directory, 'state.json');
    assert.equal(await readPrivateFile(file, MAX), undefined);
    await writePrivateFile(file, '{"v":1}', MAX);
    await writePrivateFile(file, '{"v":2}', MAX);
    assert.equal(await readPrivateFile(file, MAX), '{"v":2}');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['state.json']);
    await assert.rejects(
      writePrivateFile(file, 'x'.repeat(MAX + 1), MAX),
      refused,
    );
  }));

void test('symlinked components, wrong modes, oversized and special files are refused', () =>
  withRoot(async (root) => {
    const real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(root, 'link'));
    await assert.rejects(
      ensurePrivateDirectory(join(root, 'link', 'x')),
      refused,
    );
    const directory = join(root, 'private');
    await ensurePrivateDirectory(directory);
    const file = join(directory, 'state.json');
    await writeFile(file, 'x'.repeat(MAX + 1), { mode: 0o600 });
    await assert.rejects(readPrivateFile(file, MAX), refused);
    await writeFile(file, '{}', { mode: 0o644 });
    await chmod(file, 0o644);
    await assert.rejects(readPrivateFile(file, MAX), refused);
    await rm(file);
    await symlink(join(root, 'elsewhere'), file);
    await assert.rejects(readPrivateFile(file, MAX), refused);
    await rm(file);
    // A FIFO must be refused without blocking the reader.
    if (spawnSync('mkfifo', [file]).status === 0)
      await assert.rejects(readPrivateFile(file, MAX), refused);
  }));

void test('a held process lock refuses a second holder and is released only by its owner', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const lock = await acquireProcessLock(path);
    await assert.rejects(acquireProcessLock(path), refused);
    await lock.verify();
    await lock.release();
    const again = await acquireProcessLock(path);
    await again.release();
  }));

void test('only a lock whose owner process is gone is taken over', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(path, JSON.stringify({ pid: dead, host: hostname() }), {
      mode: 0o600,
    });
    const lock = await acquireProcessLock(path);
    await lock.verify();
    await lock.release();
    for (const owner of [
      { pid: process.pid, host: hostname() },
      { pid: dead, host: 'another-host' },
    ]) {
      await writeFile(path, JSON.stringify(owner), { mode: 0o600 });
      await assert.rejects(acquireProcessLock(path), refused);
      await rm(path);
    }
  }));

void test('a lock replaced under its holder fails verification instead of being deleted', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const lock = await acquireProcessLock(path);
    await rm(path);
    await writeFile(path, 'someone else', { mode: 0o600 });
    await assert.rejects(lock.verify(), refused);
    await assert.rejects(lock.release(), refused);
    assert.equal((await stat(path)).isFile(), true);
  }));

void test('a lock moved aside and replaced fails verification', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const lock = await acquireProcessLock(path);
    // The held file still exists with one link, just under another name.
    await rename(path, join(root, 'moved.lock'));
    await writeFile(path, 'someone else', { mode: 0o600 });
    await assert.rejects(lock.verify(), refused);
  }));

void test('concurrent takeovers of a dead lock leave at most one verified holder', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    for (let round = 0; round < 10; round++) {
      await writeFile(path, JSON.stringify({ pid: dead, host: hostname() }), {
        mode: 0o600,
      });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => acquireProcessLock(path)),
      );
      const held = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const verified = await Promise.allSettled(
        held.map((lock) => lock.verify()),
      );
      assert.ok(
        verified.filter((result) => result.status === 'fulfilled').length <= 1,
      );
      for (const lock of held) await lock.release().catch(() => {});
      await rm(path, { force: true });
    }
  }));
