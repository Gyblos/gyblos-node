// Owns the metric formulas (docs/metrics-collector.md, Aggregates) as SQL select fields over raw
// receipts and observations. Generic building blocks live in sql-primitives.ts.
import { and, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { PUBLIC_RECEIPT_STATUSES } from '@gyblos/core/constants';
import { P2P_ROLES, RECEIPT_OUTCOMES } from '@gyblos/protocol/constants';
import {
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';

import { AGGREGATES } from './constants';
import type { DayBounds } from './days';
import { conflicts, envelopes, observations, receipts } from './schema';
import type { ReceiptTotalKey } from './schema-aggregates';
import {
  count,
  histogram,
  jsonField,
  literal,
  number,
  total,
} from './sql-primitives';

const status = (value: string) => sql`${receipts.status} = ${literal(value)}`;
// Headline receipts: confirmed by both sides, or reported by the seller alone.
export const headlineReceipt = sql`${receipts.status} in (${literal(PUBLIC_RECEIPT_STATUSES.BILATERAL)}, ${literal(PUBLIC_RECEIPT_STATUSES.SELLER_ONLY)})`;
const onHeadline = (value: SQL | SQLiteColumn) =>
  sql`case when ${headlineReceipt} then ${value} end`;
// Amounts only where the buyer signed too: a seller-only amount is the seller's claim alone.
const onBilateral = (value: SQL) =>
  sql`case when ${status(PUBLIC_RECEIPT_STATUSES.BILATERAL)} then ${value} end`;
const outcome = (value: string) =>
  count(sql`${headlineReceipt} and ${receipts.outcome} = ${literal(value)}`);
export const completedHeadline = sql`${headlineReceipt} and ${receipts.outcome} = ${literal(RECEIPT_OUTCOMES.COMPLETED)}`;

// The receipt total columns over grouped raw receipts, keyed and ordered like RECEIPT_TOTAL_KEYS.
export function receiptTotalsSelect(): Record<
  ReceiptTotalKey,
  SQL | SQLiteColumn
> {
  return {
    paid: receipts.paid,
    bilateral: count(status(PUBLIC_RECEIPT_STATUSES.BILATERAL)),
    sellerOnly: count(status(PUBLIC_RECEIPT_STATUSES.SELLER_ONLY)),
    disputed: count(status(PUBLIC_RECEIPT_STATUSES.DISPUTED)),
    completed: outcome(RECEIPT_OUTCOMES.COMPLETED),
    failed: outcome(RECEIPT_OUTCOMES.FAILED),
    cancelled: outcome(RECEIPT_OUTCOMES.CANCELLED),
    inputTokens: total(onHeadline(receipts.inputTokens)),
    outputTokens: total(onHeadline(receipts.outputTokens)),
    reasoningTokens: total(onHeadline(receipts.reasoningTokens)),
    reasoningUnknown: count(
      sql`${headlineReceipt} and ${receipts.reasoningTokens} is null`,
    ),
    amountAtomic: total(
      onBilateral(sql`cast(${receipts.amountAtomic} as integer)`),
    ),
    feeAtomic: total(onBilateral(sql`cast(${receipts.feeAtomic} as integer)`)),
    firstTokenHist: histogram(onHeadline(receipts.firstTokenMs)),
    totalHist: histogram(
      sql`case when ${completedHeadline} then ${receipts.totalMs} end`,
    ),
  };
}
export function versionFields(now: number) {
  return {
    formulaVersion: sql<number>`${number(AGGREGATES.formulaVersion)}`,
    aggregatedAt: sql<number>`${now}`,
  };
}
// '' stands for no variant or quantization, so they can be primary-key columns.
export const blank = (column: SQLiteColumn) =>
  sql<string>`coalesce(${column}, '')`;
// Paid buyers are counted by wallet when the receipt names one; free buyers always by NodeId.
export const buyerIdentity = sql<string>`case when ${receipts.paid} = 1 then coalesce(${receipts.payer}, ${receipts.buyerNodeId}) else ${receipts.buyerNodeId} end`;
export const modelKey = sql<string>`${receipts.modelId} || char(31) || ${blank(receipts.variant)} || char(31) || ${blank(receipts.quantization)}`;

// Conflicts on the day's receipts with the same paid flag as the outer row. Drizzle leaves columns
// unqualified inside a raw subquery, so every name is qualified here, taken from the schema.
const qualified = (table: string, column: { name: string }) =>
  sql`${sql.identifier(table)}.${sql.identifier(column.name)}`;
export function conflictCount(bounds: DayBounds) {
  const conflict = 'conflict';
  const conflicted = 'conflicted';
  const from = (table: typeof conflicts | typeof receipts, name: string) =>
    sql`${sql.identifier(getTableName(table))} as ${sql.identifier(name)}`;
  const received = qualified(conflicted, receipts.sellerReceivedAt);
  return sql<number>`(select count(*) from ${from(conflicts, conflict)} inner join ${from(receipts, conflicted)} on ${qualified(conflicted, receipts.receiptKey)} = ${qualified(conflict, conflicts.receiptKey)} where ${received} >= ${bounds.start} and ${received} < ${bounds.end} and ${qualified(conflicted, receipts.paid)} = ${qualified(getTableName(receipts), receipts.paid)})`;
}

const json = (path: string) => jsonField(observations.recordJson, path);
export const observationJoin = eq(envelopes.id, observations.envelopeId);
const byRole = (role: string) => sql`${envelopes.role} = ${literal(role)}`;
const ofType = (type: string) => sql`${observations.type} = ${literal(type)}`;

export function observedFields() {
  const buyer = byRole(P2P_ROLES.BUYER);
  const routed = sql`${byRole(P2P_ROLES.SELLER)} and ${observations.type} in (${literal(TELEMETRY_EVENTS.COMPLETED)}, ${literal(TELEMETRY_EVENTS.FAILED)})`;
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

// Per-model observations (migrations/0007): telemetry events joined to their headline receipt, which
// gives the paid flag, the model and the day. Buyer first tokens, and the engine's own speed. A receipt
// is one request of one buyer to one seller; ingest binds a buyer event to its uploading buyer and a
// seller event to its uploading seller, so only the receipt's own two sides can attach events to it.
export const receiptOfObservation = and(
  eq(receipts.requestId, observations.requestId),
  eq(receipts.sellerNodeId, observations.sellerNodeId),
  sql`${json('buyerNodeId')} = ${receipts.buyerNodeId}`,
);
// Streaming requests only: a non-streaming completion also reports a first token, at its total time.
const buyerFirstToken = sql`${byRole(P2P_ROLES.BUYER)} and ${ofType(TELEMETRY_EVENTS.FIRST_TOKEN)} and ${json('streaming')} = 1`;
// Only completions that carry a positive generation time and output tokens.
const engineTimed = sql`${byRole(P2P_ROLES.SELLER)} and ${ofType(TELEMETRY_EVENTS.COMPLETED)} and ${json('generationMs')} > 0 and ${json('usage.outputTokens')} > 0`;
export const modelObservedEvents = sql`${headlineReceipt} and ((${buyerFirstToken}) or (${engineTimed}))`;
// One sample of each kind per receipt, grouped by receipt: an uploader repeating an event (with other
// times, so other event keys) still adds one sample; the lowest value is kept.
export function perReceiptObserved() {
  return {
    firstTokenMs: sql<
      number | null
    >`min(case when ${buyerFirstToken} then ${json('firstTokenMs')} end)`.as(
      'first_token_ms',
    ),
    tokensPerSecond: sql<
      number | null
    >`min(case when ${engineTimed} then cast(${json('usage.outputTokens')} as real) * ${number(AGGREGATES.msPerSecond)} / ${json('generationMs')} end)`.as(
      'tokens_per_second',
    ),
  };
}
