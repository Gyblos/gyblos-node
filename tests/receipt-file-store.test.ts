// Checks durable private collector state in disposable directories; no uploads, keys or node startup.
import assert from 'node:assert/strict';
import {
  chmod,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { RECEIPT_COLLECTOR_WRITES as WRITES } from '@gyblos/core/constants';
import {
  RECEIPT_FILE_CODES as CODES,
  createReceiptFileStore,
  openReceiptFileStore,
  RECEIPT_FILE_FORMAT,
  RECEIPT_FILE_LIMITS,
} from '@gyblos/telemetry-file/receipt-store';

import { receiptFileFixture } from './support/receipt-file-fixture';

void test('receipt file store preserves exact duplicates and conflicts after restart', async (context) => {
  const fixture = await receiptFileFixture(context);
  const first = await createReceiptFileStore({ path: fixture.path });
  assert.equal(await first.insert(fixture.entry), WRITES.INSERTED);
  await first.close();
  const second = await openReceiptFileStore({ path: fixture.path });
  try {
    assert.equal(await second.insert(fixture.entry), WRITES.IDENTICAL);
    assert.equal(await second.insert(fixture.conflict), WRITES.CONFLICT);
    assert.equal(await second.insert(fixture.other), WRITES.INSERTED);
  } finally {
    await second.close();
  }
});
void test('receipt file store serializes simultaneous identical writes without double insertion', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    const results = await Promise.all([
      store.insert(fixture.entry),
      store.insert(fixture.entry),
      store.insert(fixture.entry),
    ]);
    assert.equal(
      results.filter((value) => value === WRITES.INSERTED).length,
      1,
    );
    assert.equal(
      results.filter((value) => value === WRITES.IDENTICAL).length,
      2,
    );
  } finally {
    await store.close();
  }
});
void test('receipt file store preserves independent requests from the same peers concurrently', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    assert.deepEqual(
      await Promise.all([
        store.insert(fixture.entry),
        store.insert(fixture.other),
      ]),
      [WRITES.INSERTED, WRITES.INSERTED],
    );
  } finally {
    await store.close();
  }
  const reopened = await openReceiptFileStore({ path: fixture.path });
  try {
    assert.deepEqual(
      await Promise.all([
        reopened.insert(fixture.entry),
        reopened.insert(fixture.other),
      ]),
      [WRITES.IDENTICAL, WRITES.IDENTICAL],
    );
  } finally {
    await reopened.close();
  }
});
void test('receipt file store refuses a second live writer and permits one after close', async (context) => {
  const fixture = await receiptFileFixture(context);
  const first = await createReceiptFileStore({ path: fixture.path });
  try {
    await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
      code: CODES.UNAVAILABLE,
    });
  } finally {
    await first.close();
  }
  const second = await openReceiptFileStore({ path: fixture.path });
  await second.close();
});
void test('receipt file store returns FULL without evicting entries, including after restart', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({
    path: fixture.path,
    maxEntries: 1,
  });
  assert.equal(await store.insert(fixture.entry), WRITES.INSERTED);
  const before = await readFile(fixture.path);
  assert.equal(await store.insert(fixture.other), WRITES.FULL);
  assert.equal(await store.insert(fixture.entry), WRITES.IDENTICAL);
  assert.deepEqual(await readFile(fixture.path), before);
  await store.close();
  const reopened = await openReceiptFileStore({
    path: fixture.path,
    maxEntries: 1,
  });
  try {
    assert.equal(await reopened.insert(fixture.other), WRITES.FULL);
    assert.equal(await reopened.insert(fixture.entry), WRITES.IDENTICAL);
  } finally {
    await reopened.close();
  }
});
void test('receipt file store enforces snapshot bytes without partial publication', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({
    path: fixture.path,
    maxBytes: 128,
  });
  try {
    const before = await readFile(fixture.path);
    assert.equal(await store.insert(fixture.entry), WRITES.FULL);
    assert.deepEqual(await readFile(fixture.path), before);
  } finally {
    await store.close();
  }
});
void test('receipt file store cancels a queued write before modifying disk', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    const before = await readFile(fixture.path);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.insert(fixture.entry, controller.signal), {
      code: CODES.CANCELLED,
    });
    assert.deepEqual(await readFile(fixture.path), before);
    assert.equal(await store.insert(fixture.entry), WRITES.INSERTED);
  } finally {
    await store.close();
  }
});
void test('receipt file store bounds pending writes and drains admitted work on close', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({
    path: fixture.path,
    maxPending: 1,
  });
  const pending = store.insert(fixture.entry);
  const result = Promise.allSettled([pending]);
  await assert.rejects(store.insert(fixture.other), { code: CODES.BUSY });
  await store.close();
  assert.equal((await result)[0]?.status, 'fulfilled');
  await assert.rejects(store.insert(fixture.entry), { code: CODES.CLOSED });
  await store.close();
});
void test('receipt file store never recreates a missing snapshot on open or insert', async (context) => {
  const fixture = await receiptFileFixture(context);
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    await unlink(fixture.path);
    await assert.rejects(store.insert(fixture.entry), {
      code: CODES.UNAVAILABLE,
    });
  } finally {
    await store.close();
  }
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
});
void test('receipt file store creation never overwrites existing receipts', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.insert(fixture.entry);
  await store.close();
  const before = await readFile(fixture.path);
  await assert.rejects(createReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
  assert.deepEqual(await readFile(fixture.path), before);
});
void test('receipt file store rejects corrupt or ambiguous snapshots instead of resetting', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  for (const text of [
    '{',
    '{"version":1,"entries":[],"entries":[]}\n',
    '{"entries":[],"version":2}\n',
  ]) {
    await writeFile(fixture.path, text, { mode: 0o600 });
    await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
      code: CODES.CORRUPT,
    });
    assert.equal(await readFile(fixture.path, 'utf8'), text);
  }
});
void test('receipt file store refuses oversized existing state before reading its contents', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  await writeFile(fixture.path, ' '.repeat(129));
  await assert.rejects(
    openReceiptFileStore({ path: fixture.path, maxBytes: 128 }),
    { code: CODES.UNAVAILABLE },
  );
});
void test('receipt file store refuses weak permissions and symlinked snapshots', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  await chmod(fixture.path, 0o644);
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
  await chmod(fixture.path, 0o600);
  const alias = join(fixture.directory, 'alias.json');
  await symlink(fixture.path, alias);
  await assert.rejects(openReceiptFileStore({ path: alias }), {
    code: CODES.UNAVAILABLE,
  });
});
void test('receipt file store uses owner-only files and leaves no stage after a successful write', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  try {
    await store.insert(fixture.entry);
    assert.equal((await stat(fixture.path)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700);
    await assert.rejects(stat(fixture.path + RECEIPT_FILE_FORMAT.stageSuffix), {
      code: 'ENOENT',
    });
  } finally {
    await store.close();
  }
});
void test('receipt file store refuses leftover staging state without deleting it', async (context) => {
  const fixture = await receiptFileFixture(context);
  const store = await createReceiptFileStore({ path: fixture.path });
  await store.close();
  const stage = fixture.path + RECEIPT_FILE_FORMAT.stageSuffix;
  await writeFile(stage, 'synthetic', { mode: 0o600 });
  await assert.rejects(openReceiptFileStore({ path: fixture.path }), {
    code: CODES.UNAVAILABLE,
  });
  assert.equal(await readFile(stage, 'utf8'), 'synthetic');
});
void test('receipt file store rejects invalid capacities before creating any state', async (context) => {
  const fixture = await receiptFileFixture(context);
  for (const options of [
    { maxEntries: 0 },
    { maxEntries: RECEIPT_FILE_LIMITS.entries + 1 },
    { maxBytes: 0 },
    { maxPending: 0 },
  ])
    await assert.rejects(
      createReceiptFileStore({ path: fixture.path, ...options }),
      { code: CODES.INVALID_OPTIONS },
    );
});
