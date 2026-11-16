// Exercises upload retention and crash recovery using only synthetic signed receipts and isolated homes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { receiptPathsIn } from '@gyblos/config';
import { openReceiptStore } from '@gyblos/node/receipts';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { signSellerReceipt } from '@gyblos/protocol/receipt';

import { receiptChannelFixture } from './support/receipt-channel';

async function fixture() {
  const sample = await receiptChannelFixture();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gyb-upload-cursor-'));
  let now = 1700000000100;
  const options = {
    environment: { GYBLOS_HOME: root }, role: P2P_ROLES.SELLER,
    nodeId: sample.seller.nodeId, now: () => now,
    maxEntries: 1, maxBytes: 4096, retentionMs: 10,
  };
  return {
    ...sample, options, root,
    advance: (milliseconds: number) => { now += milliseconds; },
    paths: receiptPathsIn(options.environment, options.role),
    next: async (n: number) => ({ seller: await signSellerReceipt({
      ...sample.record, requestId: n.toString(16).padStart(32, '0'),
    }, sample.seller.sign) }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

void test('pending receipts survive uploaded count, byte and time retention limits across restart', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    await store.put(await f.next(2));
    await store.put(await f.next(3));
    f.advance(604800001);
    const pending = await openReceiptStore(f.options).listPending();
    assert.equal(pending.length, 3);
    assert.equal(pending[0].receipt.seller.record.requestId, f.record.requestId);
    assert.equal(pending[0].storedAt, 1700000000100);
    assert.equal((await store.uploadHealth()).rejectedWrites, 0);
  } finally { await f.close(); }
});

void test('upload acknowledgement is durable, fingerprint-CAS protected and never overwrites storedAt', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const [before] = await store.listPending();
    assert.ok(before);
    assert.equal(await store.markUploaded({ ...before, fingerprint: 'ff'.repeat(32) }, 1700000000101), false);
    assert.equal(await store.markUploaded(before, 1700000000101), true);
    assert.equal((await openReceiptStore(f.options).listPending()).length, 0);
    assert.equal(await store.confirm(f.confirm.params.receipt, new AbortController().signal), true);
    const [upgraded] = await store.listPending();
    assert.ok(upgraded?.receipt.buyer);
    assert.equal(upgraded.storedAt, before.storedAt);
    assert.notEqual(upgraded.fingerprint, before.fingerprint);
    assert.equal(await store.markUploaded(before, 1700000000102), false);
    assert.equal((await store.listPending()).length, 1);
  } finally { await f.close(); }
});

void test('uploaded receipts expire while older pending receipts remain protected', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    await store.put(await f.next(2));
    const pending = await store.listPending();
    assert.equal(pending.length, 2);
    assert.equal(await store.markUploaded(pending[1], 1700000000100), true);
    f.advance(11);
    assert.equal((await store.listPending()).length, 1);
    assert.equal(await store.load(pending[1].key, new AbortController().signal), undefined);
    assert.ok(await store.load(pending[0].key, new AbortController().signal));
  } finally { await f.close(); }
});

void test('full pending budget preserves old bodies and durably counts rejected new writes', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, maxPendingEntries: 1 };
    const store = openReceiptStore(options);
    await store.put(f.envelope);
    await assert.rejects(store.put(await f.next(2)));
    assert.equal((await store.listPending()).length, 1);
    assert.deepEqual((await store.listPending())[0].receipt, f.envelope);
    const health = await openReceiptStore(options).uploadHealth();
    assert.equal(health.rejectedWrites, 1);
    assert.equal(health.full, true);
  } finally { await f.close(); }
});

void test('legacy snapshots migrate to pending without discarding expired entries or changing their timestamps', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const storedAt = 1700000000000;
    await writeFile(f.paths.state, canonicalJson({ schemaVersion: 1, role: f.options.role,
      nodeId: f.options.nodeId, entries: [{ storedAt, receipt: f.envelope }] }) + '\n', { mode: 0o600 });
    const [migrated] = await openReceiptStore(f.options).listPending();
    assert.ok(migrated);
    assert.equal(migrated.storedAt, storedAt);
    await store.put(await f.next(2));
    assert.equal((await openReceiptStore(f.options).listPending()).length, 2);
  } finally { await f.close(); }
});

void test('normal writes append a durable record instead of rewriting earlier receipt bytes', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const before = await readFile(f.paths.state, 'utf8');
    await store.put(await f.next(2));
    const after = await readFile(f.paths.state, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal((await store.listPending()).length, 2);
  } finally { await f.close(); }
});
