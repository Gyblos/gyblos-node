import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { generateSQLiteDrizzleJson } from 'drizzle-kit/api';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as discovery from '@gyblos/discovery-index/schema';
import * as collector from '@gyblos/metrics-collector/schema';

const BASELINE_INDEX = 7;
const APPS = [
  {
    name: 'discovery-index',
    schema: discovery,
    baseline: {
      '0001_discovery_index.sql':
        'cdf12d641b8fa81a51dee7af3d16555566cf5122005c55aa1671db1f0acfe72f',
      '0002_listing_indexes.sql':
        'f83e8e09f1e60cbb90e07c5727f51b732c0f6848be2f9846abe3fd56acdd7325',
      '0003_registrations.sql':
        'ee95354a78c2766a2572631ca0e2ff77b731d2e1436802bdcbee27245e4c12ad',
      '0004_uptime.sql':
        '0a25e4b27821bb1a5982f451e72a3f35bf979a0bc8390b8c66dc2a7d23e07ccf',
      '0005_node_publish_quota.sql':
        'e3ff68db8e899c4df12eebb6dd18ae092f431a61f4b671280905edc6f3b2a7a1',
      '0006_presence_version.sql':
        'd516c6042b102d2e1a2401876fea113076f113e3a0a88d42223259236dbf44c1',
      '0007_github_claims.sql':
        'bbc78cb453a2520aa44a8f6e80b276ee440bb54637640d059b7734df2b126e05',
    },
  },
  {
    name: 'metrics-collector',
    schema: collector,
    baseline: {
      '0001_metrics_collector.sql':
        'ecad550458f54c51812b149f4ec4663152507a367b1aed69cdce705d51d15ec2',
      '0002_metrics_aggregates.sql':
        'b7cc4a403f28d4901b6def2b850d26d2f8b81b75d87354aeb4c350c8712990d1',
      '0003_chain_index.sql':
        '629ceac2c09b56c12e8aa666864368e3947eddde915f7253aa9474800ebdfff8',
      '0004_chain_aggregates.sql':
        '43f90bb5c0205647c9670dc8aa6dcd6b605415b8e9ef627e6449c34826b46a62',
      '0005_breakdowns.sql':
        'b403ddebdf9908b289092b4c5123bdb19cb48cbaf76ce317876a605e9c699299',
      '0006_chain_gyblos_only.sql':
        '71b8fb5c053d555cc0b371c79c9046d8556077d4259f477e3b3efe240de861d4',
      '0007_model_observed.sql':
        'fb1c02e8843424bb339e84da8e1260c7251e8f75f3d7cc2c3086faab934b7ff4',
    },
  },
] as const;

const migrations = (app: string) =>
  new URL(`../apps/${app}/migrations/`, import.meta.url);
const read = (url: URL) => readFileSync(url, 'utf8').replaceAll('\r\n', '\n');
const sqlFiles = (app: string) =>
  readdirSync(migrations(app))
    .filter((name) => name.endsWith('.sql'))
    .sort();
const prefix = (index: number) => String(index).padStart(4, '0');

interface Journal {
  dialect: string;
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (app: string): Journal =>
  JSON.parse(read(new URL('meta/_journal.json', migrations(app))));
const snapshot = (app: string, index: number): Record<string, unknown> =>
  JSON.parse(
    read(new URL(`meta/${prefix(index)}_snapshot.json`, migrations(app))),
  );
const described = ({ id, prevId, _meta, ...rest }: Record<string, unknown>) => {
  void [id, prevId, _meta];
  return rest;
};

const dataOnly = (sql: string) =>
  !/\b(create|alter|drop|pragma|reindex|vacuum|attach|detach)\b/i.test(
    sql.replaceAll(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
      ' ',
    ),
  );

void test('the data-only check sees DDL hidden behind a string that looks like a comment', () => {
  assert.equal(dataOnly("UPDATE t SET a = '--'; DROP TABLE x;"), false);
  assert.equal(dataOnly("-- it's a backfill\nDROP TABLE x; -- '"), false);
  for (const hidden of [
    'SELECT 1 AS "--"; DROP TABLE x;',
    'SELECT 1 AS `a--`; DROP TABLE x;',
    'SELECT 1 AS [--]; DROP TABLE x;',
    'SELECT 1 AS "it\'s"; DROP TABLE x; -- \'',
  ])
    assert.equal(dataOnly(hidden), false, hidden);
  for (const statement of [
    'PRAGMA foreign_keys = OFF;',
    'REINDEX t;',
    'VACUUM;',
    "ATTACH 'x.db' AS x;",
    'DETACH x;',
  ])
    assert.equal(dataOnly(statement), false, statement);
});

void test('the data-only check accepts data statements with comments and strings', () => {
  assert.equal(
    dataOnly('UPDATE "drop" SET "create" = 1, `alter` = 2, [pragma] = 3;'),
    true,
  );
  assert.equal(
    dataOnly(
      "-- Custom SQL migration file, put your code below! --\nUPDATE t SET note = 'drop -- create' WHERE id = 1; /* backfill */\nDELETE FROM u WHERE a = 'it''s';",
    ),
    true,
  );
});

for (const app of APPS) {
  void test(`${app.name}: the latest drizzle-kit snapshot matches schema.ts (run db:generate)`, async () => {
    const entries = journal(app.name).entries;
    const latest = entries.at(-1);
    assert.ok(latest);
    const current = await generateSQLiteDrizzleJson({ ...app.schema });
    assert.deepEqual(
      described(JSON.parse(JSON.stringify(current))),
      described(snapshot(app.name, latest.idx)),
    );
  });

  void test(`${app.name}: snapshot checks carry literal values, never bound parameters`, () => {
    const latest = journal(app.name).entries.at(-1);
    assert.ok(latest);
    const tables = Object.values(
      snapshot(app.name, latest.idx).tables as Record<
        string,
        { checkConstraints: Record<string, { value: string }> }
      >,
    );
    const checks = tables.flatMap((table) =>
      Object.values(table.checkConstraints),
    );
    assert.ok(checks.length > 0);
    for (const check of checks) assert.doesNotMatch(check.value, /\?/);
  });

  void test(`${app.name}: journal, snapshots and SQL files agree; baseline files are unchanged`, () => {
    const files = sqlFiles(app.name);
    const baseline: Record<string, string> = app.baseline;
    for (const [file, hash] of Object.entries(baseline))
      assert.equal(
        createHash('sha256')
          .update(read(new URL(file, migrations(app.name))))
          .digest('hex'),
        hash,
        `${file} is applied in production and must never change`,
      );
    const { dialect, entries } = journal(app.name);
    assert.equal(dialect, 'sqlite');
    assert.equal(entries[0]?.idx, BASELINE_INDEX);
    assert.ok(`${entries[0].tag}.sql` in baseline);
    entries.forEach((entry, position) => {
      assert.equal(entry.idx, BASELINE_INDEX + position);
      assert.ok(entry.tag.startsWith(`${prefix(entry.idx)}_`), entry.tag);
      if (position > 0)
        assert.ok(entry.when > (entries[position - 1]?.when ?? 0), entry.tag);
      assert.ok(snapshot(app.name, entry.idx));
    });
    const generated = entries.slice(1).map((entry) => `${entry.tag}.sql`);
    assert.deepEqual(files, [...Object.keys(baseline), ...generated].sort());
    assert.deepEqual(
      readdirSync(new URL('meta/', migrations(app.name))).sort(),
      [
        '_journal.json',
        '_sha256.json',
        ...entries.map((entry) => `${prefix(entry.idx)}_snapshot.json`),
      ].sort(),
    );
  });

  void test(`${app.name}: every migration file is recorded and unchanged since`, () => {
    const recorded: Record<string, string> = JSON.parse(
      read(new URL('meta/_sha256.json', migrations(app.name))),
    );
    const files = sqlFiles(app.name);
    for (const file of files) {
      assert.ok(
        file in recorded,
        `${file} is not recorded: run pnpm db:hashes after writing it`,
      );
      assert.equal(
        createHash('sha256')
          .update(read(new URL(file, migrations(app.name))))
          .digest('hex'),
        recorded[file],
        `${file} changed after it was recorded; applied migrations are never edited, add a new one`,
      );
    }
    assert.deepEqual(Object.keys(recorded).sort(), files);
  });

  void test(`${app.name}: generated migrations keep every WITHOUT ROWID table`, () => {
    const layout = (files: readonly string[]) => {
      const database = new DatabaseSync(':memory:');
      for (const file of files)
        database.exec(read(new URL(file, migrations(app.name))));
      return database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    };
    const all = sqlFiles(app.name);
    const before = layout(Object.keys(app.baseline));
    const after = new Set(layout(all));
    assert.ok(before.length > 0);
    for (const table of before) assert.ok(after.has(table), table);
  });

  void test(`${app.name}: custom (data-only) migrations hold no schema statements`, () => {
    const entries = journal(app.name).entries;
    entries.slice(1).forEach((entry, position) => {
      const previous = entries[position];
      assert.ok(previous);
      const schemaChanged = !isDeepStrictEqual(
        described(snapshot(app.name, entry.idx)),
        described(snapshot(app.name, previous.idx)),
      );
      if (schemaChanged) return;
      assert.ok(
        dataOnly(read(new URL(`${entry.tag}.sql`, migrations(app.name)))),
        `${entry.tag} is a custom migration: schema changes must be generated from schema.ts`,
      );
    });
  });
}

void test('metrics-collector: the envelopes (uploader, nonce) unique stays as the live table has it', () => {
  const uniques = getTableConfig(collector.envelopes).uniqueConstraints.map(
    (constraint) => ({
      name: constraint.getName(),
      columns: constraint.columns.map((column) => column.name),
    }),
  );
  assert.deepEqual(
    uniques,
    [
      {
        name: 'collector_envelopes_uploader_node_id_nonce_unique',
        columns: ['uploader_node_id', 'nonce'],
      },
    ],
    'the live inline UNIQUE cannot be dropped with the DROP INDEX drizzle-kit would generate; see the comment above this test',
  );
});
