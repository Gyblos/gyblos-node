// Protects the collector's D1 cost model and schema: one read and one bounded batch per upload, with no
// statement per receipt beyond chunking (no N+1), every statement under D1's bound-parameter limit,
// and a typed ORM schema that matches the real migration, checks included.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { COLLECTOR_LIMITS } from '@gyblos/metrics-collector/constants';
import * as schema from '@gyblos/metrics-collector/schema';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';
import { signSellerReceipt } from '@gyblos/protocol/receipt';
import { RECEIPT_UPLOAD } from '@gyblos/protocol/receipt-upload';

import { signUpload, testCollector } from './support/metrics-collector';
import { createCollectorD1 } from './support/metrics-collector-d1';
import { receiptSigner, sellerRecord } from './support/receipt-fixture';
import { sellerUpload } from './support/receipt-upload';

async function upload(count: number) {
  const seller = receiptSigner();
  const items = [];
  for (let index = 0; index < count; index++) {
    const record = {
      ...sellerRecord(seller.nodeId, receiptSigner().nodeId),
      requestId: index.toString(16).padStart(32, '0'),
    };
    items.push({
      receipt: { seller: await signSellerReceipt(record, seller.sign) },
      storedAt: null,
      startedAt: null,
      offer: null,
    });
  }
  const body = {
    ...sellerUpload(seller.nodeId, items[0]!.receipt),
    items,
  };
  return signUpload(body, seller.sign);
}

async function cost(count: number) {
  const database = createCollectorD1();
  const { post } = testCollector(createD1Storage(database));
  const response = await post(await upload(count));
  assert.equal(response.status, 200);
  return {
    direct: database.log.filter((entry) => entry.kind === 'direct'),
    batched: database.log.filter((entry) => entry.kind === 'batch'),
    batches: new Set(
      database.log.filter((e) => e.kind === 'batch').map((e) => e.batch),
    ).size,
    log: database.log,
  };
}

void test('one upload costs one read and one batch whose size does not grow per receipt', async () => {
  const one = await cost(1);
  const full = await cost(RECEIPT_UPLOAD.maxItems);
  for (const run of [one, full]) {
    assert.equal(run.direct.length, 1, 'one typed read for all keys');
    assert.equal(run.batches, 1, 'one transactional batch');
  }
  // Envelope, reports, conflicts, receipts, history, first report time.
  assert.equal(one.batched.length, 6);
  // Only the two multi-row inserts are chunked (9 report rows and 3 receipt rows per statement under
  // the 100-parameter limit); everything else is set-based: 1 + 6 + 1 + 17 + 1 + 1.
  assert.equal(full.batched.length, 27);
  for (const entry of full.log)
    assert.ok(
      entry.params.length <= COLLECTOR_LIMITS.maxBoundParameters,
      `statement with ${entry.params.length} bound parameters`,
    );
});

void test('the typed schema matches the migrated tables, keys and indexes', () => {
  const database = createCollectorD1();
  const tables = Object.values(schema).map((table) => getTableConfig(table));
  const migrated = database
    .rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'collector_%' ORDER BY name",
    )
    .map((row) => row.name);
  assert.deepEqual(tables.map((table) => table.name).sort(), migrated);
  for (const table of tables) {
    const actual = database.raw
      .prepare(
        'SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid',
      )
      .all(table.name)
      .map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull === 1,
      }));
    assert.deepEqual(
      actual,
      table.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
      })),
      table.name,
    );
    const primary = database.raw
      .prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
      .all(table.name)
      .map((column) => column.name);
    const declared = [
      ...table.columns.filter((column) => column.primary).map((c) => c.name),
      ...table.primaryKeys.flatMap((key) => key.columns.map((c) => c.name)),
    ];
    assert.deepEqual(primary, declared, `${table.name} primary key`);
    const indexes = database.raw
      .prepare(
        "SELECT name FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name",
      )
      .all(table.name)
      .map((index) => index.name);
    assert.deepEqual(
      indexes,
      table.indexes.map((index) => index.config.name).sort(),
      `${table.name} indexes`,
    );
    const uniques = database.raw
      .prepare("SELECT name FROM pragma_index_list(?) WHERE origin = 'u'")
      .all(table.name)
      .map((index) =>
        database.raw
          .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
          .all(String(index.name))
          .map((column) => column.name),
      );
    assert.deepEqual(
      uniques,
      table.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
      `${table.name} unique constraints`,
    );
  }
});

void test('the typed schema preserves the migrated check constraints', () => {
  const database = createCollectorD1();
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema).map((item) =>
    getTableConfig(item),
  )) {
    const [row] = database.rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table.name}'`,
    );
    assert.ok(row);
    const normalize = (expression: string) =>
      expression
        .replaceAll(/["()\s]/g, '')
        .replaceAll(`${table.name}.`, '')
        .toLowerCase();
    const actual = [
      ...String(row.sql).matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi),
    ]
      .map((match) => normalize(match[1] ?? ''))
      .sort();
    const declared = table.checks
      .map((check) => normalize(dialect.sqlToQuery(check.value).sql))
      .sort();
    assert.deepEqual(declared, actual, table.name);
  }
});
