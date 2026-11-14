// Compares the public ORM schema with independently applied historical SQLite migrations.
// Metadata must preserve real columns, keys, indexes and checks before future schema changes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Column, is } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import * as schema from '@gyblos/discovery-index/schema';

import { createSqliteD1 } from './support/d1-sqlite';

void test('discovery ORM schema matches migrated columns and primary keys', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    const primary = new Set(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    );
    const actual = database.raw
      .prepare(
        'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
      )
      .all(config.name)
      .map((column) => ({
        name: column.name,
        type: column.type,
        notNull: Boolean(column.notnull),
        default: column.dflt_value === null ? null : String(column.dflt_value),
        primary: Number(column.pk) > 0,
      }));
    assert.deepEqual(
      config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
        default: column.default === undefined ? null : String(column.default),
        primary: column.primary || primary.has(column.name),
      })),
      actual,
      config.name,
    );
  }
});

void test('discovery ORM schema owns every migrated secondary index and its column order', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    const actual = database.raw
      .prepare(
        "SELECT name FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name",
      )
      .all(config.name)
      .map((index) => ({
        name: String(index.name),
        columns: database.raw
          .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
          .all(String(index.name))
          .map((column) => column.name),
      }));
    const declared = config.indexes
      .map(({ config: index }) => ({
        name: index.name,
        columns: index.columns.map((column) => {
          assert.ok(is(column, Column), index.name);
          return column.name;
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(declared, actual, config.name);
  }
});

void test('discovery ORM schema preserves migrated check constraints', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  const dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    const row = database.raw
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(config.name);
    assert.ok(row);
    const normalize = (expression: string) =>
      expression
        .replaceAll(/["()\s]/g, '')
        .replaceAll(`${config.name}.`, '')
        .toLowerCase();
    const actual = [
      ...String(row.sql).matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi),
    ]
      .map((match) => normalize(match[1]))
      .sort();
    const declared = config.checks
      .map((check) =>
        normalize(dialect.sqlToQuery(check.value.inlineParams()).sql),
      )
      .sort();
    assert.deepEqual(declared, actual, config.name);
  }
});
