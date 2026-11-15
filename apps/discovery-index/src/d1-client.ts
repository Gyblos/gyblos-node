// Connects Drizzle's SQLite remote driver to native D1 statements and transactional batches.
// Only ORM-generated queries cross this boundary; returned values remain untrusted data.
import { drizzle } from 'drizzle-orm/sqlite-proxy';

export type D1Value = string | number | null;
export type D1Row = Record<string, unknown>;
export interface D1Result {
  meta: { changes: number };
  results?: D1Row[];
}
export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  all(): Promise<{ results: D1Row[] }>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
function parameter(value: unknown): D1Value {
  if (value === null || typeof value === 'string' || typeof value === 'number')
    return value;
  throw new TypeError('Unexpected discovery ORM parameter.');
}
export function createD1Orm(database: D1Database) {
  return drizzle(
    async (query: string, parameters: unknown[], method) => {
      const statement = database
        .prepare(query)
        .bind(...parameters.map(parameter));
      if (method === 'run') {
        await statement.run();
        return { rows: [] };
      }
      const { results } = await statement.all();
      const rows = results.map((row) => Object.values(row));
      return { rows: method === 'get' ? (rows[0] ?? []) : rows };
    },
    async (queries) => {
      const results = await database.batch(
        queries.map((query) =>
          database.prepare(query.sql).bind(...query.params.map(parameter)),
        ),
      );
      return results.map((result) => ({
        rows: (result.results ?? []).map((row) => Object.values(row)),
      }));
    },
  );
}
export type DiscoveryDatabase = ReturnType<typeof createD1Orm>;
