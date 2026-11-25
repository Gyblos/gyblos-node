// Contains SQLite expressions that Drizzle 0.45 cannot build, plus typed projection bindings.
// No complete query or external SQL text is accepted; every dynamic value stays parameterized.
import {
  eq,
  isNull,
  or,
  sql,
  type GetColumnData,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { DiscoveryListingIndex } from './constants';
import type { D1Value } from './d1-client';

export const valueField = <T extends D1Value>(value: T, name: string) =>
  sql<T>`${value}`.as(name);
export const columnField = <T extends AnySQLiteColumn>(
  column: T,
  name: string,
) => sql<GetColumnData<T>>`${column}`.as(name);

// Without these hints SQLite chooses the WITHOUT ROWID primary tables instead of the covering
// indexes, reading signed blobs before pagination. The key-only EXPLAIN contract proves this need.
export const coveringIndex = (
  table: SQLiteTable,
  name: DiscoveryListingIndex,
) => sql`${table} indexed by ${sql.identifier(name)}`;

export const jsonTextValues = (values: readonly string[]) =>
  sql`(select value from json_each(${JSON.stringify(values)}))`;

// SQLite's scalar length has no Drizzle builder; schema checks must retain the physical bounds.
export const textLength = (column: AnySQLiteColumn) =>
  sql<number>`length(${column})`;
export const nullableTextLength = (
  column: AnySQLiteColumn,
  characters: number,
) => sql<boolean>`${or(isNull(column), eq(textLength(column), characters))}`;

// Drizzle's SQLite SELECT builder requires a FROM source. This one-row source allows the initial
// insert to enforce capacity/reference predicates even when every application table is empty.
export const singleRow = () => sql`(values (1))`;

// Drizzle's max() is an aggregate, not SQLite's two-argument scalar max. These updates must stay
// inside the high-water write: reading the previous values in JavaScript would introduce a race.
export const maximum = (
  column: AnySQLiteColumn<{ data: number }>,
  value: number,
) => sql<number>`max(${column}, ${value})`;

// Scalar min has the same API gap as max; uptime's earliest sighting must survive concurrent writes.
export const minimum = (
  column: AnySQLiteColumn<{ data: number }>,
  value: number,
) => sql<number>`min(${column}, ${value})`;

// Keep the capacity count in CASE's lazy branch so an existing uptime identity never scans the table.
export const capacityAdmission = (existing: SQL, capacity: SQL) =>
  sql<boolean>`case when ${existing} then 1 else ${capacity} end`;

// Drizzle has no SQLite bitwise-OR builder. Slots from concurrent sightings must merge in the write.
export const slotCount = (
  column: AnySQLiteColumn<{ data: number }>,
  bit: number,
) => sql<number>`sum((${column} >> ${bit}) & 1)`;

export const mergedBits = (
  column: AnySQLiteColumn<{ data: number }>,
  bits: number,
) => sql<number>`${column} | ${bits}`;

// Drizzle has no CASE builder. Increment/reset must be decided atomically using the stored window;
// a delayed request must not rewind it or lose a concurrent accepted publication.
export const publicationCount = (
  window: AnySQLiteColumn<{ data: number }>,
  count: AnySQLiteColumn<{ data: number }>,
  incoming: number,
) =>
  sql<number>`case when ${window} >= ${incoming} then ${count} + 1 else 1 end`;

// Drizzle cannot place a correlated subquery in a SELECT list. The network read takes each NodeId's
// newest uptime row this way: one primary-key lookup per NodeId instead of an aggregate over its history.
export const scalarSubquery = (query: SQLWrapper) => sql<unknown>`(${query})`;

// An inconclusive gist check must not rewind a newer check landed meanwhile: checked_at only moves
// forward, a claim still unscheduled stays so (SQLite's scalar max is NULL when any argument is), and only
// a pending claim records that GitHub could not answer. Decided in the write, never from a snapshot.
export const laterTime = (
  column: AnySQLiteColumn<{ data: number }>,
  value: number,
) => sql<number>`max(coalesce(${column}, ${value}), ${value})`;
export const laterOrUnscheduled = (
  column: AnySQLiteColumn<{ data: number }>,
  value: number | null,
) => sql<number | null>`max(${column}, ${value})`;
export const pendingReason = (
  state: AnySQLiteColumn,
  reason: AnySQLiteColumn,
  pending: string,
  unavailable: string,
) =>
  sql<
    string | null
  >`case when ${state} = ${pending} then ${unavailable} else ${reason} end`;

export const whenElse = <T>(
  condition: SQL | undefined,
  then: SQLWrapper | D1Value,
  otherwise: SQLWrapper | D1Value,
) => sql<T>`case when ${condition} then ${then} else ${otherwise} end`;
export const nullField = (name: string) => sql<null>`null`.as(name);
export const jsonOfferRows = (hash: string, json: string, guard: SQL) =>
  sql`select ${hash}, cast(key as integer), json_extract(value, '$.modelId'), json_extract(value, '$.variant'), json_extract(value, '$.quantization'), json_extract(value, '$.contextTokens'), json_extract(value, '$.reasoning'), json_extract(value, '$.pricing.inputAtomicPerMtok'), json_extract(value, '$.pricing.outputAtomicPerMtok'), json_extract(value, '$.pricing.unit'), json_extract(value, '$.pricing.network'), json_extract(value, '$.pricing.asset') from json_each(${json}) where ${guard}`;
export const atLeast = (value: number, floor: SQLWrapper) =>
  sql<number>`max(${value}, coalesce((${floor}), ${value}))`;
export const atMost = (value: SQL, cap: number) =>
  sql<number>`min(${value}, ${cap})`;
