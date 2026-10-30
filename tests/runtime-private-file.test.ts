// Private file primitives and the process lock: owner-only directories without symlinked
// components, bounded no-follow reads, atomic writes, and a lock only a dead owner can lose.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
      { pid: process.ppid, host: hostname() },
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

void test('the own pid in a lock it does not hold is stale, as after a container restart', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, host: hostname() }),
      { mode: 0o600 },
    );
    const lock = await acquireProcessLock(path);
    // Held now, so this process's second acquisition is refused.
    await assert.rejects(acquireProcessLock(path), refused);
    await lock.release();
  }));

void test('a takeover guard left by a crash refuses takeover until removed', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(path, JSON.stringify({ pid: dead, host: hostname() }), {
      mode: 0o600,
    });
    await writeFile(`${path}.takeover`, '', { mode: 0o600 });
    await assert.rejects(acquireProcessLock(path), refused);
    await rm(`${path}.takeover`);
    await (await acquireProcessLock(path)).release();
  }));

function contend(path: string, holdMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(import.meta.dirname, 'support', 'lock-contender.ts'),
        path,
        String(holdMs),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(output.trim()));
  });
}

void test('processes racing to take over a dead lock never hold it at the same time', () =>
  withRoot(async (root) => {
    await ensurePrivateDirectory(root);
    const path = join(root, 'ledger.lock');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(path, JSON.stringify({ pid: dead, host: hostname() }), {
      mode: 0o600,
    });
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () => contend(path, 300)),
    );
    const held = outputs
      .filter((line) => line.startsWith('held '))
      .map((line) => line.split(' ').slice(1).map(Number))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    assert.ok(held.length >= 1, outputs.join('\n'));
    for (let index = 1; index < held.length; index++)
      assert.ok((held[index]?.[0] ?? 0) >= (held[index - 1]?.[1] ?? 0));
    assert.ok(
      outputs.every((line) => line === 'refused' || line.startsWith('held ')),
    );
  }));
