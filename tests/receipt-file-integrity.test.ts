// Covers process ownership, tampering and cancellation using disposable signed receipt snapshots only.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { link, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RECEIPT_COLLECTOR_CODES,
  RECEIPT_COLLECTOR_STATUSES,
  RECEIPT_COLLECTOR_WRITES as WRITES,
} from '@gyblos/core/constants';
import { createPrivateReceiptCollector } from '@gyblos/core/receipt-collector';
import { canonicalJson } from '@gyblos/protocol';
import {
  RECEIPT_FILE_CODES as CODES,
  createReceiptFileStore,
  openReceiptFileStore,
  RECEIPT_FILE_FORMAT,
} from '@gyblos/telemetry-file/receipt-store';

import { receiptBytes } from './support/receipt-collector';
import { receiptFileFixture } from './support/receipt-file-fixture';

void test('private collector preserves its duplicate/conflict decisions with a real file backend', async (context) => {
  const fixture = await receiptFileFixture(context);
  const first = await createReceiptFileStore({ path: fixture.path });
  const collector = createPrivateReceiptCollector(first);
  assert.deepEqual(
    await collector.collect(receiptBytes(fixture.entry.receipt)),
    { status: RECEIPT_COLLECTOR_STATUSES.STORED },
  );
  await first.close();
  const second = await openReceiptFileStore({ path: fixture.path });
  try {
    const reopened = createPrivateReceiptCollector(second);
    assert.deepEqual(
      await reopened.collect(receiptBytes(fixture.entry.receipt)),
      { status: RECEIPT_COLLECTOR_STATUSES.DUPLICATE },
    );
    await assert.rejects(
      reopened.collect(receiptBytes(fixture.conflict.receipt)),
      { code: RECEIPT_COLLECTOR_CODES.CONFLICT },
    );
  } finally {
    await second.close();
  }
});
void test(
  'receipt file store excludes a real second process until its writer closes',
  { timeout: 15000 },
  async (context) => {
    const fixture = await receiptFileFixture(context);
    const first = await createReceiptFileStore({ path: fixture.path });
    await first.insert(fixture.entry);
    await first.close();
    const child = fork(
      fileURLToPath(
        new URL('./support/receipt-file-worker.ts', import.meta.url),
      ),
      [fixture.path],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          PATH: process.env.PATH ?? '',
          GYBLOS_HOME: fixture.directory,
          GYBLOS_LAB_HOME: fixture.directory,
        },
      },
    );
    const exited = once(child, 'exit');
    context.after(async () => {
      if (child.connected) child.disconnect();
      await exited;
    });
    const [message] = await once(child, 'message');
    assert.deepEqual(message, { ready: true });
    await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
      code: CODES.UNAVAILABLE,
    });
    child.disconnect();
    assert.deepEqual(await exited, [0, null]);
    const reopened = await openReceiptFileStore({ path: fixture.path });
    try {
      assert.equal(await reopened.insert(fixture.entry), WRITES.IDENTICAL);
    } finally {
      await reopened.close();
    }
  },
);
void test('receipt file store re-verifies signed snapshots and derived keys before reopening', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.insert(fixture.entry);
  await store.close();
  const original = await readFile(fixture.path, 'utf8');
  const variants = [
    { ...fixture.entry, fingerprint: '00'.repeat(32) },
    { ...fixture.entry, key: 'synthetic-invalid-key' },
    {
      ...fixture.entry,
      receipt: {
        ...fixture.entry.receipt,
        seller: { ...fixture.entry.receipt.seller, signature: '00'.repeat(64) },
      },
    },
  ];
  for (const entry of variants) {
    const text =
      canonicalJson({
        version: RECEIPT_FILE_FORMAT.version,
        entries: [entry],
      }) + '\n';
    await writeFile(fixture.path, text);
    await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
      code: CODES.CORRUPT,
    });
    assert.equal(await readFile(fixture.path, 'utf8'), text);
  }
  await writeFile(fixture.path, original);
  const reopened = await openReceiptFileStore({ path: fixture.path });
  await reopened.close();
});
void test('receipt file store rejects duplicate snapshot keys instead of silently merging history', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  await writeFile(
    fixture.path,
    canonicalJson({
      version: RECEIPT_FILE_FORMAT.version,
      entries: [fixture.entry, fixture.entry],
    }) + '\n',
  );
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.CORRUPT,
  });
});
void test('receipt file store detects an unexpected snapshot change while it owns the lock', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    const foreign =
      canonicalJson({
        version: RECEIPT_FILE_FORMAT.version,
        entries: [fixture.other],
      }) + '\n';
    await writeFile(fixture.path, foreign);
    await assert.rejects(store.insert(fixture.entry), {
      code: CODES.UNAVAILABLE,
    });
    assert.equal(await readFile(fixture.path, 'utf8'), foreign);
  } finally {
    await store.close();
  }
});
void test('receipt file store rejects hardlinked state', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  await link(fixture.path, join(fixture.directory, 'linked.json'));
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
});
void test('receipt file store snapshots queued caller input before async verification', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  const candidate = structuredClone(fixture.entry);
  const pending = store.insert(candidate);
  candidate.key = 'synthetic-changed-key';
  candidate.receipt.seller.record.requestDigest = '00'.repeat(32);
  try {
    assert.equal(await pending, WRITES.INSERTED);
    assert.equal(await store.insert(fixture.entry), WRITES.IDENTICAL);
  } finally {
    await store.close();
  }
});
void test('receipt file store cancellation after admission leaves prior snapshot intact', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  const before = await readFile(fixture.path);
  const controller = new AbortController();
  const pending = store.insert(fixture.entry, controller.signal);
  controller.abort();
  try {
    await assert.rejects(pending, { code: CODES.CANCELLED });
    assert.deepEqual(await readFile(fixture.path), before);
    await assert.rejects(stat(fixture.path + RECEIPT_FILE_FORMAT.stageSuffix), {
      code: 'ENOENT',
    });
  } finally {
    await store.close();
  }
});

void test('receipt file store rejects invalid missing options with a static typed code', async () => {
  // Deliberately invalid public API input must not expose a raw TypeError.
  await assert.rejects(
    createReceiptFileStore(
      null as unknown as Parameters<typeof createReceiptFileStore>[0],
    ),
    { code: CODES.INVALID_OPTIONS },
  );
});
