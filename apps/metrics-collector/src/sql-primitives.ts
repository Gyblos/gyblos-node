// Owns the generic SQL building blocks of the aggregates: validated literals, conditional counts and
// sums, fixed-bucket histograms, numeric ranges and column-ordered INSERT ... SELECT fields. Constants
// are inlined as literals (validated here), so statements bind only request-independent values.
import { and, getTableColumns, gte, lt, SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { AGGREGATES } from './constants';

const LITERAL = /^[a-z0-9_-]+$/;
const JSON_PATH = /^[A-Za-z][A-Za-z0-9.]*$/;
// A known constant as an SQL string literal; anything outside the safe alphabet is a programming error.
export function literal(value: string): SQL {
  if (!LITERAL.test(value)) throw new Error('Unsafe aggregate literal.');
  return sql.raw(`'${value}'`);
}
export const number = (value: number) => sql.raw(String(Math.trunc(value)));
// `json_extract(column, '$.path')` for a constant path.
export function jsonField(column: SQLiteColumn, path: string): SQL {
  if (!JSON_PATH.test(path)) throw new Error('Unsafe aggregate JSON path.');
  return sql`json_extract(${column}, ${sql.raw(`'$.${path}'`)})`;
}

export const count = (condition: SQL) =>
  sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
// SQLite total(): 0 over no rows and a float instead of an integer overflow error, so one huge value
// can never make a day fail. Ingest bounds keep every stored total far below 2^53, where it is exact.
export const total = (value: SQL | SQLiteColumn) =>
  sql<number>`total(${value})`;
export const distinctWhere = (value: SQL | SQLiteColumn, condition: SQL) =>
  sql<number>`count(distinct case when ${condition} then ${value} end)`;

// The UTC day (YYYY-MM-DD) of an epoch-ms column; NULL past year 9999.
export const dayOf = (at: SQLiteColumn | SQL) =>
  sql<string>`strftime('%Y-%m-%d', ${at} / 1000, 'unixepoch')`;
// [start, end) on a numeric column.
export const inRange = (
  column: SQLiteColumn,
  range: { start: number; end: number },
) => and(gte(column, range.start), lt(column, range.end));

// A JSON array of bucket counts over AGGREGATES.latencyBucketsMs; a value equal to a bound falls in
// the next bucket, and null values are not counted.
export function histogram(value: SQL | SQLiteColumn) {
  const edges = AGGREGATES.latencyBucketsMs;
  const parts = edges.map((edge, index) =>
    index === 0
      ? count(sql`${value} < ${number(edge)}`)
      : count(
          sql`${value} >= ${number(edges[index - 1]!)} and ${value} < ${number(edge)}`,
        ),
  );
  parts.push(count(sql`${value} >= ${number(edges.at(-1)!)}`));
  return sql<string>`json_array(${sql.join(parts, sql`, `)})`;
}
// Bucket-by-bucket sum of a histogram column over grouped rows, as a JSON array.
export function histogramSum(column: SQLiteColumn) {
  const parts = Array.from(
    { length: AGGREGATES.latencyBucketsMs.length + 1 },
    (_, index) =>
      sql`coalesce(sum(json_extract(${column}, ${sql.raw(`'$[${index}]'`)})), 0)`,
  );
  return sql<string>`json_array(${sql.join(parts, sql`, `)})`;
}

// SQL expressions in an INSERT ... SELECT need aliases; columns keep their own names.
type Aliased<T> = {
  [K in keyof T]: T[K] extends SQL<infer V> ? SQL.Aliased<V> : T[K];
};
// Drizzle's INSERT ... SELECT lists the table's columns and the SELECT's fields positionally, so the
// fields must name exactly the table's columns in order. Checked when the statement is built (every
// aggregate statement is built by the tests).
export function ordered<T extends Record<string, unknown>>(
  table: SQLiteTable,
  fields: T,
): Aliased<T> {
  const expected = Object.keys(getTableColumns(table)).join();
  if (Object.keys(fields).join() !== expected)
    throw new Error('Aggregate fields do not match the table column order.');
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof SQL ? value.as(key) : value,
    ]),
  ) as Aliased<T>;
}
