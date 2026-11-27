// Minimal D1-compatible database over node:sqlite for metrics collector tests only. It applies the real
// migrations and runs a batch in one transaction, like D1.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Row,
  D1Value,
} from '@gyblos/metrics-collector/storage-d1';

import { D1_LOG_KINDS, type D1LogEntry } from './d1-sqlite';

const MIGRATIONS = new URL(
  '../../apps/metrics-collector/migrations/',
  import.meta.url,
);

export interface SqliteD1 extends D1Database {
  raw: DatabaseSync;
  rows(sql: string): D1Row[];
  // Every statement sent: direct reads/writes and each statement of every batch, with its parameters.
  log: D1LogEntry[];
}

// D1 refuses a statement with more bound parameters than this; node:sqlite would not.
export const D1_MAX_BOUND_PARAMETERS = 100;
function checkParameters(params: D1Value[]) {
  if (params.length > D1_MAX_BOUND_PARAMETERS)
    throw new Error('too many SQL variables');
}

export function createCollectorD1(): SqliteD1 {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    raw.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  const log: SqliteD1['log'] = [];
  let batches = 0;
  const statement = (
    sql: string,
    params: D1Value[] = [],
  ): D1PreparedStatement => ({
    bind: (...values) => {
      checkParameters(values);
      return statement(sql, values);
    },
    all: () => {
      log.push({ kind: D1_LOG_KINDS.DIRECT, batch: 0, sql, params });
      return Promise.resolve({
        results: raw.prepare(sql).all(...params) as D1Row[],
      });
    },
    run: () => {
      log.push({ kind: D1_LOG_KINDS.DIRECT, batch: 0, sql, params });
      const result = raw.prepare(sql).run(...params);
      return Promise.resolve({ meta: { changes: Number(result.changes) } });
    },
  });
  const pending = new WeakMap<D1PreparedStatement, () => D1Result>();
  return {
    raw,
    log,
    rows: (sql) => raw.prepare(sql).all() as D1Row[],
    prepare(sql) {
      const make = (params: D1Value[]): D1PreparedStatement => {
        const prepared = statement(sql, params);
        const wrapped: D1PreparedStatement = {
          bind: (...values) => make(values),
          all: prepared.all,
          run: prepared.run,
        };
        pending.set(wrapped, () => {
          checkParameters(params);
          log.push({ kind: D1_LOG_KINDS.BATCH, batch: batches, sql, params });
          const query = raw.prepare(sql);
          // Like D1, a batched statement that returns rows (a SELECT) carries them in `results`.
          if (query.columns().length)
            return {
              meta: { changes: 0 },
              results: query.all(...params) as D1Row[],
            };
          const result = query.run(...params);
          return { meta: { changes: Number(result.changes) }, results: [] };
        });
        return wrapped;
      };
      return make([]);
    },
    batch(statements) {
      batches += 1;
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
