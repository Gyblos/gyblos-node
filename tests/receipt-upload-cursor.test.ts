// Exercises upload retention and crash recovery using only synthetic signed receipts and isolated homes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { receiptPathsIn } from '@gyblos/config';
import { NODE_ERROR_CODES, RECEIPT_UPLOAD } from '@gyblos/node/constants';
import {
  createSellerReceiptRuntime,
  listReceipts,
  openReceiptStore,
  type ReceiptStoreOptions,
} from '@gyblos/node/receipts';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import { signSellerReceipt } from '@gyblos/protocol/receipt';

import { receiptChannelFixture } from './support/receipt-channel';

async function reopenedInChild(options: ReceiptStoreOptions) {
  const script = `
    import { openReceiptStore, listReceipts } from '@gyblos/node/receipts';
    const { clock, ...settings } = JSON.parse(process.argv[1]);
    settings.now = () => clock;
    const store = openReceiptStore(settings);
    const health = await store.uploadHealth();
    const entries = (await listReceipts(settings)).map(({ storedAt, uploadedAt }) => ({ storedAt, uploadedAt }));
    process.stdout.write(JSON.stringify({ health, entries }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      script,
      JSON.stringify({ ...options, clock: options.now?.() ?? Date.now() }),
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  const result: unknown = JSON.parse(stdout);
  return controlObject(result, ['health', 'entries']);
}

async function fixture() {
  const sample = await receiptChannelFixture();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyb-upload-cursor-'),
  );
  let now = 1700000000100;
  const options = {
    environment: { GYBLOS_HOME: root },
    role: P2P_ROLES.SELLER,
    nodeId: sample.seller.nodeId,
    now: () => now,
    maxEntries: 1,
    maxBytes: 4096,
    retentionMs: 10,
  };
  return {
    ...sample,
    options,
    root,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    paths: receiptPathsIn(options.environment, options.role),
    next: async (n: number) => ({
      seller: await signSellerReceipt(
        {
          ...sample.record,
          requestId: n.toString(16).padStart(32, '0'),
        },
        sample.seller.sign,
      ),
    }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

void test('pending receipts survive uploaded count, byte and time retention limits across restart', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    f.advance(1);
    await store.put(await f.next(2));
    await store.put(await f.next(3));
    f.advance(604800001);
    const pending = await openReceiptStore(f.options).listPending();
    assert.equal(pending.length, 3);
    const original = pending[0];
    assert.ok(original);
    assert.equal(original.receipt.seller.record.requestId, f.record.requestId);
    assert.equal(original.storedAt, 1700000000100);
    assert.equal((await store.uploadHealth()).rejectedWrites, 0);
  } finally {
    await f.close();
  }
});

void test('upload acknowledgement is durable, fingerprint-CAS protected and never overwrites storedAt', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const [before] = await store.listPending();
    assert.ok(before);
    assert.equal(
      await store.markUploaded(
        { ...before, fingerprint: 'ff'.repeat(32) },
        1700000000101,
      ),
      false,
    );
    assert.equal(await store.markUploaded(before, 1700000000101), true);
    assert.equal((await openReceiptStore(f.options).listPending()).length, 0);
    f.advance(1);
    assert.equal(
      await store.confirm(
        f.confirm.params.receipt,
        new AbortController().signal,
      ),
      true,
    );
    const [upgraded] = await store.listPending();
    assert.ok(upgraded?.receipt.buyer);
    assert.equal(upgraded.storedAt, before.storedAt);
    assert.notEqual(upgraded.fingerprint, before.fingerprint);
    assert.equal(await store.markUploaded(before, 1700000000102), false);
    assert.equal((await store.listPending()).length, 1);
  } finally {
    await f.close();
  }
});

void test('uploaded receipts expire while older pending receipts remain protected', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    await store.put(await f.next(2));
    const pending = await store.listPending();
    assert.equal(pending.length, 2);
    const [first, second] = pending;
    assert.ok(first && second);
    assert.equal(await store.markUploaded(second, 1700000000100), true);
    f.advance(11);
    assert.equal((await store.listPending()).length, 1);
    assert.equal(
      await store.load(second.key, new AbortController().signal),
      undefined,
    );
    assert.ok(await store.load(first.key, new AbortController().signal));
  } finally {
    await f.close();
  }
});

void test('full pending budget preserves old bodies and durably counts rejected new writes', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, maxPendingEntries: 1 };
    const store = openReceiptStore(options);
    await store.put(f.envelope);
    await assert.rejects(store.put(await f.next(2)));
    assert.equal((await store.listPending()).length, 1);
    const [held] = await store.listPending();
    assert.ok(held);
    assert.deepEqual(held.receipt, f.envelope);
    const health = await openReceiptStore(options).uploadHealth();
    assert.equal(health.rejectedWrites, 1);
    assert.equal(health.full, true);
    assert.deepEqual((await reopenedInChild(options)).health, health);
    const runtime = createSellerReceiptRuntime({
      nodeId: f.seller.nodeId,
      store,
      signer: f.seller.sign,
    });
    assert.equal(runtime.health().storage?.full, true);
    assert.equal(runtime.health().storage?.rejectedWrites, 1);
    await runtime.close();
  } finally {
    await f.close();
  }
});

void test('legacy snapshots migrate to pending without discarding expired entries or changing their timestamps', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const storedAt = 1700000000000;
    await writeFile(
      f.paths.state,
      canonicalJson({
        schemaVersion: 1,
        role: f.options.role,
        nodeId: f.options.nodeId,
        entries: [{ storedAt, receipt: f.envelope }],
      }) + '\n',
      { mode: 0o600 },
    );
    const [migrated] = await openReceiptStore(f.options).listPending();
    assert.ok(migrated);
    assert.equal(migrated.storedAt, storedAt);
    await store.put(await f.next(2));
    assert.equal((await openReceiptStore(f.options).listPending()).length, 2);
  } finally {
    await f.close();
  }
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
  } finally {
    await f.close();
  }
});

void test('pending bodies ignore the uploaded byte cap and the pending byte budget reports rejection', async () => {
  const f = await fixture();
  try {
    const options = {
      ...f.options,
      maxBytes: 1,
      maxPendingBytes: RECEIPT_UPLOAD.reservedEntryBytes,
    };
    const store = openReceiptStore(options);
    await store.put(f.envelope);
    await assert.rejects(store.put(await f.next(2)), {
      code: NODE_ERROR_CODES.RECEIPT_STORAGE_FULL,
    });
    const [pending] = await store.listPending();
    assert.ok(pending);
    assert.equal(
      (await store.uploadHealth()).pendingBytes,
      RECEIPT_UPLOAD.reservedEntryBytes,
    );
    assert.equal(await store.markUploaded(pending, 1700000000101), true);
    await store.put(await f.next(2));
    assert.equal((await store.listPending()).length, 1);
    assert.equal((await store.uploadHealth()).rejectedWrites, 1);
  } finally {
    await f.close();
  }
});

void test('first upload confirmation is immutable and caller mutations cannot alter stored metadata', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const [cursor] = await store.listPending();
    assert.ok(cursor);
    await store.markUploaded(cursor, 1700000000101);
    await store.markUploaded(cursor, 1700000000102);
    const [held] = await listReceipts(f.options);
    assert.ok(held);
    assert.equal(held.uploadedAt, 1700000000101);
    assert.equal(held.storedAt, cursor.storedAt);
    assert.deepEqual((await reopenedInChild(f.options)).entries, [
      { storedAt: cursor.storedAt, uploadedAt: 1700000000101 },
    ]);
    cursor.receipt.seller.signature = '00'.repeat(64);
    const fresh = await openReceiptStore(f.options).load(
      cursor.key,
      new AbortController().signal,
    );
    assert.deepEqual(fresh, f.envelope);
  } finally {
    await f.close();
  }
});

void test('buyer roles use the same persistent pending queue without accessing any existing profile', async () => {
  const f = await fixture();
  try {
    const options = {
      ...f.options,
      role: P2P_ROLES.BUYER,
      nodeId: f.buyer.nodeId,
    };
    const store = openReceiptStore(options);
    await store.put(f.confirm.params.receipt);
    const [cursor] = await openReceiptStore(options).listPending();
    assert.ok(cursor?.receipt.buyer);
    await store.markUploaded(cursor, 1700000000101);
    assert.equal(
      (await openReceiptStore(options).uploadHealth()).pendingEntries,
      0,
    );
  } finally {
    await f.close();
  }
});

void test('a crash-torn UTF-8 tail preserves complete receipts and is truncated before the next append', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    await appendFile(
      f.paths.state,
      Buffer.concat([
        Buffer.from(
          '{"entry":' + 'x'.repeat(RECEIPT_UPLOAD.reservedEntryBytes),
        ),
        Buffer.from('é').subarray(0, 1),
      ]),
    );
    const reopened = openReceiptStore(f.options);
    assert.equal((await reopened.listPending()).length, 1);
    await reopened.put(await f.next(2));
    assert.equal((await openReceiptStore(f.options).listPending()).length, 2);
    assert.doesNotMatch(await readFile(f.paths.state, 'utf8'), /�/);
    assert.ok((await readFile(f.paths.state, 'utf8')).endsWith('\n'));
  } finally {
    await f.close();
  }
});

void test('compaction preserves pending records and rejection counters on reopen', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, maxPendingEntries: 1 };
    const store = openReceiptStore(options);
    await store.put(f.envelope);
    const operation =
      canonicalJson({ entry: null, evicted: [], rejectedWrites: 0 }) + '\n';
    await appendFile(
      f.paths.state,
      operation.repeat(
        Math.ceil(
          RECEIPT_UPLOAD.compactAfterBytes / Buffer.byteLength(operation),
        ) + 1,
      ),
    );
    const before = (await readFile(f.paths.state)).length;
    await assert.rejects(store.put(await f.next(2)), {
      code: NODE_ERROR_CODES.RECEIPT_STORAGE_FULL,
    });
    assert.ok((await readFile(f.paths.state)).length < before);
    const reopened = openReceiptStore(options);
    assert.equal((await reopened.listPending()).length, 1);
    assert.equal((await reopened.uploadHealth()).rejectedWrites, 1);
  } finally {
    await f.close();
  }
});

void test('competing store instances cannot spend the last pending slot twice', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, maxPendingEntries: 1 };
    const first = openReceiptStore(options);
    const second = openReceiptStore(options);
    const results = await Promise.allSettled([
      first.put(f.envelope),
      second.put(await f.next(2)),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const health = await openReceiptStore(options).uploadHealth();
    assert.equal(health.pendingEntries, 1);
    assert.equal(health.full, true);
    assert.equal((await openReceiptStore(options).listPending()).length, 1);
  } finally {
    await f.close();
  }
});

void test('legacy snapshots reject uncommitted trailing bytes because the old format was never append-only', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    await writeFile(
      f.paths.state,
      canonicalJson({
        schemaVersion: 1,
        role: f.options.role,
        nodeId: f.options.nodeId,
        entries: [{ storedAt: 1700000000100, receipt: f.envelope }],
      }) + '\ntrailing-corruption',
      { mode: 0o600 },
    );
    await assert.rejects(openReceiptStore(f.options).listPending(), {
      code: NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE,
    });
  } finally {
    await f.close();
  }
});
