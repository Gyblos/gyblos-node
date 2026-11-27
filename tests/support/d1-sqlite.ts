// Minimal D1-compatible database over node:sqlite for discovery index tests only. It applies every
// real migration in apps/discovery-index/migrations and runs a batch in one transaction, like D1.
import { readdirSync, readFileSync } from 'node:fs';

import type {
  D1Database,
  D1PreparedStatement,
  D1Row,
  D1Value,
} from '@gyblos/discovery-index/storage-d1';

const MIGRATIONS = new URL(
  '../../apps/discovery-index/migrations/',
  import.meta.url,
);
export const DISCOVERY_TABLES = [
  'discovery_nodes',
  'discovery_catalogs',
  'discovery_catalog_models',
  'discovery_presence',
  'discovery_withdrawals',
] as const;

type Sqlite = InstanceType<typeof import('node:sqlite').DatabaseSync>;

export interface SqliteD1 extends D1Database {
  raw: Sqlite;
  prepare(query: string): SqliteStatement;
  dump(): string;
  log: D1LogEntry[];
}

export interface D1LogEntry {
  kind: 'direct' | 'batch';
  batch: number;
  sql: string;
  params: D1Value[];
}

export interface SqliteStatement extends D1PreparedStatement {
  sql: string;
  params: D1Value[];
}

export interface SqliteQueryPlanRow {
  id: number;
  parent: number;
  detail: string;
}

export function explainD1Statement(
  database: Pick<SqliteD1, 'raw'>,
  statement: Pick<SqliteStatement, 'sql' | 'params'>,
): SqliteQueryPlanRow[] {
  return database.raw
    .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
    .all(...statement.params)
    .map((row) => ({
      id: Number(row.id),
      parent: Number(row.parent),
      detail: String(row.detail),
    }));
}

function row(value: unknown): D1Row {
  return value && typeof value === 'object' ? { ...value } : {};
}

export async function createSqliteD1(): Promise<SqliteD1 | null> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  const log: D1LogEntry[] = [];
  let batches = 0;
  const run = (sql: string, params: D1Value[]) => {
    const results = db
      .prepare(sql)
      .all(...params)
      .map(row);
    const changes = Number(db.prepare('SELECT changes() AS n').get()?.n ?? 0);
    return { meta: { changes }, results };
  };
  const statement = (sql: string, params: D1Value[] = []): SqliteStatement => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    all: async () => {
      log.push({ kind: 'direct', batch: 0, sql, params });
      return {
        results: db
          .prepare(sql)
          .all(...params)
          .map(row),
      };
    },
    run: async () => {
      log.push({ kind: 'direct', batch: 0, sql, params });
      return run(sql, params);
    },
  });
  return {
    raw: db,
    log,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      batches += 1;
      db.exec('BEGIN');
      try {
        const results = statements.map((item) => {
          const { sql, params } = item as SqliteStatement;
          log.push({ kind: 'batch', batch: batches, sql, params });
          return run(sql, params);
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    dump: () =>
      DISCOVERY_TABLES.map((table) =>
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
      ).join('\n'),
  };
}
