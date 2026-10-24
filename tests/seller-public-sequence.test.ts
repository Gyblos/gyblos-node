// Exercises durable public-v2 numbering in temporary seller homes, never real role keys or journals.
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout } from '@gyblos/config/home';
import { openSellerSequence } from '@gyblos/node/public-sequence';

async function isolated() {
  const home = await mkdtemp(join(tmpdir(), 'seller-sequence-'));
  const environment = { GYBLOS_HOME: home };
  const options = { environment, nodeId: '1'.repeat(64), initialFloor: 100 };
  const file = join(
    homeLayout(environment).roles.seller,
    'public-sequence-v2.json',
  );
  return {
    options,
    file,
    close: () => rm(home, { recursive: true, force: true }),
  };
}
void test('public sequence reservations survive restarts and a backwards initialization clock', async () => {
  const run = await isolated();
  try {
    const first = await openSellerSequence(run.options);
    assert.equal(await first.next(), 100);
    assert.equal(await first.next(200), 201);
    const restarted = await openSellerSequence({
      ...run.options,
      initialFloor: 1,
    });
    assert.equal(await restarted.next(), 202);
    assert.equal(await first.next(), 203);
    assert.equal(JSON.parse(await readFile(run.file, 'utf8')).highWater, 203);
  } finally {
    await run.close();
  }
});
void test('concurrent public reservations from one allocator never repeat and state stays private', async () => {
  const run = await isolated();
  try {
    const source = await openSellerSequence(run.options);
    const values = await Promise.all(
      Array.from({ length: 24 }, () => source.next()),
    );
    assert.equal(new Set(values).size, 24);
    assert.deepEqual(
      values,
      Array.from({ length: 24 }, (_, index) => 100 + index),
    );
    const { stat } = await import('node:fs/promises');
    if (process.platform !== 'win32') {
      assert.equal((await stat(run.file)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(homeLayout(run.options.environment).roles.seller)).mode &
          0o777,
        0o700,
      );
    }
  } finally {
    await run.close();
  }
});
void test('public sequence state rejects malformed namespace, extra fields and another node identity', async () => {
  const run = await isolated();
  try {
    const source = await openSellerSequence(run.options);
    await source.next();
    const good = JSON.parse(await readFile(run.file, 'utf8'));
    for (const change of [
      { extra: true },
      { recordVersion: 1 },
      { nodeId: '2'.repeat(64) },
      { highWater: -1 },
    ]) {
      await writeFile(run.file, JSON.stringify({ ...good, ...change }));
      await assert.rejects(openSellerSequence(run.options));
    }
  } finally {
    await run.close();
  }
});
void test('public sequence refuses rollback, missing held state and unsafe files rather than resetting', async () => {
  const run = await isolated();
  try {
    const source = await openSellerSequence(run.options);
    await source.next();
    const old = JSON.parse(await readFile(run.file, 'utf8'));
    await source.next();
    await writeFile(run.file, JSON.stringify(old));
    await assert.rejects(source.next());
    const fresh = await openSellerSequence(run.options);
    await fresh.next();
    await rm(run.file);
    await assert.rejects(fresh.next());
    const target = join(run.options.environment.GYBLOS_HOME, 'target');
    await writeFile(target, '{}');
    await symlink(target, run.file);
    await assert.rejects(openSellerSequence(run.options));
  } finally {
    await run.close();
  }
});
void test('public sequence lock contention and exhausted counters fail closed', async () => {
  const run = await isolated();
  try {
    const source = await openSellerSequence(run.options);
    await source.next();
    const lock = join(
      homeLayout(run.options.environment).roles.seller,
      'public-sequence-v2.lock',
    );
    await writeFile(lock, 'synthetic existing lock', { mode: 0o600 });
    await assert.rejects(source.next());
    assert.equal(await readFile(lock, 'utf8'), 'synthetic existing lock');
    await rm(lock);
    const value = JSON.parse(await readFile(run.file, 'utf8'));
    value.highWater = Number.MAX_SAFE_INTEGER;
    await writeFile(run.file, JSON.stringify(value));
    const exhausted = await openSellerSequence(run.options);
    await assert.rejects(exhausted.next());
    if (process.platform !== 'win32') {
      await chmod(run.file, 0o644);
      await assert.rejects(openSellerSequence(run.options));
    }
  } finally {
    await run.close();
  }
});
