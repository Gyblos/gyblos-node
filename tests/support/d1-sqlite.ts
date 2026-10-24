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
}

export interface SqliteStatement extends D1PreparedStatement {
  sql: string;
  params: D1Value[];
}

// D1 accepts ordered ?NNN parameters; node:sqlite binds them reliably by name.
export const namedSql = (sql: string) => sql.replace(/\?(\d+)/g, ':p$1');
export const namedParams = (params: D1Value[]) =>
  Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));

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
  const run = (sql: string, params: D1Value[]) => ({
    meta: {
      changes: Number(
        db.prepare(namedSql(sql)).run(namedParams(params)).changes,
      ),
    },
  });
  const statement = (sql: string, params: D1Value[] = []): SqliteStatement => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    first: async () => {
      const found = db.prepare(namedSql(sql)).get(namedParams(params));
      return found ? row(found) : null;
    },
    all: async () => ({
      results: db.prepare(namedSql(sql)).all(namedParams(params)).map(row),
    }),
    run: async () => run(sql, params),
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((item) => {
          const { sql, params } = item as SqliteStatement;
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
