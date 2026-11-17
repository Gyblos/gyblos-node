// Owns the set-based SQL that recomputes one UTC day of aggregates from raw rows: each table is a
// DELETE for the day plus one INSERT ... SELECT ... GROUP BY, so the cost depends on the day's raw
// rows, never on a statement per row. Constants are inlined as SQL literals (validated here) so a
// statement binds only the day bounds and the run time, far under D1's parameter limit.
import { and, eq, getTableColumns, gte, lt, SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { PUBLIC_RECEIPT_STATUSES } from '@gyblos/core/constants';
import { P2P_ROLES, RECEIPT_OUTCOMES } from '@gyblos/protocol/constants';
import {
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';

import { AGGREGATES } from './constants';
import { envelopes, observations, receipts } from './schema';

export interface DayBounds {
  day: string;
  start: number;
  end: number;
}
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// The UTC day's [start, end) in epoch ms, or undefined for a malformed or impossible day.
export function dayBounds(day: string): DayBounds | undefined {
  if (!DAY_PATTERN.test(day)) return undefined;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(start) ||
    !new Date(start).toISOString().startsWith(`${day}T`)
  )
    return undefined;
  return { day, start, end: start + AGGREGATES.dayMs };
}
export const dayOf = (at: SQLiteColumn | SQL) =>
  sql<string>`strftime('%Y-%m-%d', ${at} / 1000, 'unixepoch')`;
export const inRange = (at: SQLiteColumn, bounds: DayBounds) =>
  and(gte(at, bounds.start), lt(at, bounds.end));

const LITERAL = /^[a-z0-9_-]+$/;
// A known constant as an SQL string literal; anything outside the safe alphabet is a programming error.
export function literal(value: string): SQL {
  if (!LITERAL.test(value)) throw new Error('Unsafe aggregate literal.');
  return sql.raw(`'${value}'`);
}
const number = (value: number) => sql.raw(String(Math.trunc(value)));

export const count = (condition: SQL) =>
  sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
const total = (value: SQL) => sql<number>`coalesce(sum(${value}), 0)`;

// A JSON array of bucket counts over AGGREGATES.latencyBucketsMs; null values are not counted.
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

// Selected fields must follow the table's column order: Drizzle's INSERT ... SELECT lists the
// table's columns and the SELECT's fields positionally.
// SQL expressions in an INSERT ... SELECT need aliases; columns keep their own names.
type Aliased<T> = {
  [K in keyof T]: T[K] extends SQL<infer V> ? SQL.Aliased<V> : T[K];
};
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

const headline = sql`${receipts.status} in (${literal(PUBLIC_RECEIPT_STATUSES.BILATERAL)}, ${literal(PUBLIC_RECEIPT_STATUSES.SELLER_ONLY)})`;
const onHeadline = (value: SQL | SQLiteColumn) =>
  sql`case when ${headline} then ${value} end`;
const outcome = (value: string) =>
  count(sql`${headline} and ${receipts.outcome} = ${literal(value)}`);

// Additive receipt columns, in the order of the tables' receiptTotals() columns.
export function receiptTotals() {
  return {
    paid: receipts.paid,
    bilateral: count(
      sql`${receipts.status} = ${literal(PUBLIC_RECEIPT_STATUSES.BILATERAL)}`,
    ),
    sellerOnly: count(
      sql`${receipts.status} = ${literal(PUBLIC_RECEIPT_STATUSES.SELLER_ONLY)}`,
    ),
    disputed: count(
      sql`${receipts.status} = ${literal(PUBLIC_RECEIPT_STATUSES.DISPUTED)}`,
    ),
    completed: outcome(RECEIPT_OUTCOMES.COMPLETED),
    failed: outcome(RECEIPT_OUTCOMES.FAILED),
    cancelled: outcome(RECEIPT_OUTCOMES.CANCELLED),
    inputTokens: total(onHeadline(receipts.inputTokens)),
    outputTokens: total(onHeadline(receipts.outputTokens)),
    reasoningTokens: total(onHeadline(receipts.reasoningTokens)),
    reasoningUnknown: count(
      sql`${headline} and ${receipts.reasoningTokens} is null`,
    ),
    amountAtomic: total(
      onHeadline(sql`cast(${receipts.amountAtomic} as integer)`),
    ),
    feeAtomic: total(onHeadline(sql`cast(${receipts.feeAtomic} as integer)`)),
    firstTokenHist: histogram(onHeadline(receipts.firstTokenMs)),
    totalHist: histogram(
      sql`case when ${headline} and ${receipts.outcome} = ${literal(RECEIPT_OUTCOMES.COMPLETED)} then ${receipts.totalMs} end`,
    ),
  };
}
export function versionFields(now: number) {
  return {
    formulaVersion: sql<number>`${number(AGGREGATES.formulaVersion)}`,
    aggregatedAt: sql<number>`${now}`,
  };
}
export const blank = (column: SQLiteColumn) =>
  sql<string>`coalesce(${column}, '')`;
// Paid buyers are counted by wallet when the receipt names one; free buyers always by NodeId.
export const buyerIdentity = sql<string>`case when ${receipts.paid} = 1 then coalesce(${receipts.payer}, ${receipts.buyerNodeId}) else ${receipts.buyerNodeId} end`;
export const completedHeadline = sql`${headline} and ${receipts.outcome} = ${literal(RECEIPT_OUTCOMES.COMPLETED)}`;
export const headlineReceipt = headline;
export const modelKey = sql<string>`${receipts.modelId} || char(31) || ${blank(receipts.variant)} || char(31) || ${blank(receipts.quantization)}`;

// Conflicts per paid flag for the day's receipts, joined set-based. Written with qualified names:
// Drizzle leaves single-table columns unqualified, which would bind `paid` to the inner table.
export function conflictCount(bounds: DayBounds) {
  const outer = sql.raw('"collector_receipts"."paid"');
  return sql<number>`(select count(*) from "collector_conflicts" as conflict inner join "collector_receipts" as conflicted on conflicted.receipt_key = conflict.receipt_key where conflicted.seller_received_at >= ${bounds.start} and conflicted.seller_received_at < ${bounds.end} and conflicted.paid = ${outer})`;
}

const json = (path: string) =>
  sql`json_extract(${observations.recordJson}, ${sql.raw(`'$.${path}'`)})`;
export const observationJoin = eq(envelopes.id, observations.envelopeId);
const byRole = (role: string) => sql`${envelopes.role} = ${literal(role)}`;
const ofType = (type: string) => sql`${observations.type} = ${literal(type)}`;

export function observedFields() {
  const buyer = byRole(P2P_ROLES.BUYER);
  const seller = byRole(P2P_ROLES.SELLER);
  const routed = sql`${seller} and ${observations.type} in (${literal(TELEMETRY_EVENTS.COMPLETED)}, ${literal(TELEMETRY_EVENTS.FAILED)})`;
  const route = (value: string) =>
    count(sql`${routed} and ${json('path.route')} = ${literal(value)}`);
  return {
    buyerFirstTokenHist: histogram(
      sql`case when ${buyer} and ${ofType(TELEMETRY_EVENTS.FIRST_TOKEN)} then ${json('firstTokenMs')} end`,
    ),
    buyerTotalHist: histogram(
      sql`case when ${buyer} and ${ofType(TELEMETRY_EVENTS.COMPLETED)} then ${json('totalMs')} end`,
    ),
    routeDirect: route(EXECUTION_ROUTES.DIRECT),
    routeRelay: route(EXECUTION_ROUTES.RELAY),
    // Completed or failed executions with no path, or an unknown one.
    routeUnknown: count(
      sql`${routed} and coalesce(${json('path.route')}, ${literal(EXECUTION_ROUTES.UNKNOWN)}) = ${literal(EXECUTION_ROUTES.UNKNOWN)}`,
    ),
  };
}

export function demandFields() {
  const refused = ofType(TELEMETRY_EVENTS.REFUSED);
  const connect = sql`${json('refusal')} = ${literal(TELEMETRY_REFUSALS.CONNECT_FAILED)}`;
  return {
    unserved: count(ofType(TELEMETRY_EVENTS.UNSERVED)),
    refusedBeforeSelection: count(
      sql`${refused} and ${json('sellerNodeId')} is null and not (${connect})`,
    ),
    connectFailed: count(sql`${refused} and ${connect}`),
  };
}
export const demandEvents = sql`${byRole(P2P_ROLES.BUYER)} and ${observations.type} in (${literal(TELEMETRY_EVENTS.UNSERVED)}, ${literal(TELEMETRY_EVENTS.REFUSED)})`;
