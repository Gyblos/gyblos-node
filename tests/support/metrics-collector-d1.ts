// Minimal D1-compatible database over node:sqlite for metrics collector tests only. It applies the real
// migrations and runs a batch in one transaction, like D1.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type {
  D1Database,
  D1PreparedStatement,
  D1Row,
  D1Value,
} from '@gyblos/metrics-collector/storage-d1';

const MIGRATIONS = new URL(
  '../../apps/metrics-collector/migrations/',
  import.meta.url,
);

export interface SqliteD1 extends D1Database {
  raw: DatabaseSync;
  rows(sql: string): D1Row[];
}

export function createCollectorD1(): SqliteD1 {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).sort())
    raw.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  const statement = (
    sql: string,
    params: D1Value[] = [],
  ): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    all: () =>
      Promise.resolve({
        results: raw.prepare(sql).all(...params) as D1Row[],
      }),
    run: () => Promise.resolve(raw.prepare(sql).run(...params)),
  });
  const pending = new WeakMap<D1PreparedStatement, () => unknown>();
  return {
    raw,
    rows: (sql) => raw.prepare(sql).all() as D1Row[],
    prepare(sql) {
      const make = (params: D1Value[]): D1PreparedStatement => {
        const prepared = statement(sql, params);
        const wrapped: D1PreparedStatement = {
          bind: (...values) => make(values),
          all: prepared.all,
          run: prepared.run,
        };
        pending.set(wrapped, () => raw.prepare(sql).run(...params));
        return wrapped;
      };
      return make([]);
    },
    batch(statements) {
      raw.exec('BEGIN');
      try {
        const results = statements.map((s) => pending.get(s)!());
        raw.exec('COMMIT');
        return Promise.resolve(results);
      } catch (error) {
        raw.exec('ROLLBACK');
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
}
