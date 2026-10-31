// Private retention and replay tests use synthetic pairs and disposable files only.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createRetainedReceiptStore,
  openRetainedReceiptStore,
} from '@gyblos/telemetry-file/retained-receipts';

import { managedReceiptFixture } from './support/local-collector';

void test('retained receipts remove expired bodies and keep replay decisions after restart', async (context) => {
  const f = await managedReceiptFixture(context);
  let now = 1000;
  const options = { path: f.path, retentionMs: 100, now: () => now };
  const first = await createRetainedReceiptStore(options);
  f.manage(first);
  assert.equal(await first.insert(f.entry), 'inserted');
  await first.close();
  now = 1100;
  const second = await openRetainedReceiptStore(options);
  f.manage(second);
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(state.entries[0].receipt, null);
  assert.equal(await second.insert(f.entry), 'identical');
  assert.equal(await second.insert(f.conflict), 'conflict');
  assert.equal(
    JSON.parse(await readFile(f.path, 'utf8')).entries[0].receipt,
    null,
  );
});
void test('retained receipt tombstones consume capacity without eviction', async (context) => {
  const f = await managedReceiptFixture(context);
  let now = 1000;
  const store = await createRetainedReceiptStore({
    path: f.path,
    retentionMs: 10,
    now: () => now,
    maxEntries: 1,
  });
  f.manage(store);
  assert.equal(await store.insert(f.entry), 'inserted');
  now = 1010;
  await store.sweep();
  assert.equal(await store.insert(f.other), 'full');
  assert.equal(await store.insert(f.entry), 'identical');
});
void test('retained receipt writes serialize concurrent duplicates and refuse changed retention', async (context) => {
  const f = await managedReceiptFixture(context);
  const options = { path: f.path, retentionMs: 100, now: () => 1000 };
  const store = await createRetainedReceiptStore(options);
  f.manage(store);
  assert.deepEqual(
    (await Promise.all([store.insert(f.entry), store.insert(f.entry)])).sort(),
    ['identical', 'inserted'],
  );
  await store.close();
  await assert.rejects(
    openRetainedReceiptStore({ ...options, retentionMs: 101 }),
    { code: 'RECEIPT_FILE_CORRUPT' },
  );
});
void test('retained receipt store refuses corruption and never recreates missing history', async (context) => {
  const f = await managedReceiptFixture(context);
  const options = { path: f.path, retentionMs: 100, now: () => 1000 };
  await assert.rejects(openRetainedReceiptStore(options), {
    code: 'RECEIPT_FILE_UNAVAILABLE',
  });
  const store = await createRetainedReceiptStore(options);
  await store.close();
  await writeFile(f.path, '{}');
  await assert.rejects(openRetainedReceiptStore(options), {
    code: 'RECEIPT_FILE_CORRUPT',
  });
});
void test('retained receipt cancellation preserves prior bytes and clock rollback cannot revive bodies', async (context) => {
  const f = await managedReceiptFixture(context);
  let now = 1000;
  const options = { path: f.path, retentionMs: 10, now: () => now };
  const store = await createRetainedReceiptStore(options);
  f.manage(store);
  assert.equal(await store.insert(f.entry), 'inserted');
  const before = await readFile(f.path, 'utf8');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(store.insert(f.other, abort.signal), {
    code: 'RECEIPT_FILE_CANCELLED',
  });
  assert.equal(await readFile(f.path, 'utf8'), before);
  now = 1010;
  await store.sweep();
  await store.close();
  now = 900;
  const second = await openRetainedReceiptStore(options);
  f.manage(second);
  assert.equal(
    JSON.parse(await readFile(f.path, 'utf8')).entries[0].receipt,
    null,
  );
  assert.equal(await second.insert(f.entry), 'identical');
});
