// Owns the breakdown formulas of the network stats: requests by the buyer application that reported
// them, and failed, refused and unserved observations by side, application, event and reason. Each
// row keeps its distinct buyer count so the public answer can withhold it below the buyer minimum.
import {
  and,
  countDistinct,
  eq,
  getTableName,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { P2P_ROLES, RECEIPT_OUTCOMES } from '@gyblos/protocol/constants';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import {
  buyerIdentity,
  headlineReceipt,
  observationJoin,
  versionFields,
} from './aggregate-sql';
import { BREAKDOWNS } from './constants';
import type { CollectorDatabase } from './d1-client';
import type { DayBounds } from './days';
import {
  aggFailuresDaily,
  aggOriginDaily,
  envelopes,
  observations,
  receipts,
  reports,
} from './schema';
import { count, inRange, jsonField, literal, ordered } from './sql-primitives';

type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];
const qualified = (alias: string, column: SQLiteColumn) =>
  sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
const aliased = (table: SQLiteTable, alias: string) =>
  sql`${sql.identifier(getTableName(table))} as ${sql.identifier(alias)}`;

// The client of a buyer-role upload that carried the receipt; unknown when only the seller did. The
// outer receipt is named by its table, since Drizzle leaves columns unqualified in a raw subquery.
const origin = sql<string>`coalesce((select min(${qualified('oe', envelopes.clientKind)})
  from ${aliased(reports, 'orp')} join ${aliased(envelopes, 'oe')} on ${qualified('oe', envelopes.id)} = ${qualified('orp', reports.envelopeId)}
  where ${qualified('orp', reports.receiptKey)} = ${qualified(getTableName(receipts), receipts.receiptKey)}
    and ${qualified('orp', reports.role)} = ${literal(P2P_ROLES.BUYER)}), ${literal(BREAKDOWNS.unknownClient)})`;

const outcome = (value: string) =>
  count(sql`${receipts.outcome} = ${literal(value)}`);

function originRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
): BatchItem[] {
  return [
    database.delete(aggOriginDaily).where(eq(aggOriginDaily.day, bounds.day)),
    database.insert(aggOriginDaily).select(
      database
        .select(
          ordered(aggOriginDaily, {
            day: sql<string>`${bounds.day}`,
            paid: receipts.paid,
            clientKind: origin,
            requests: sql<number>`count(*)`,
            completed: outcome(RECEIPT_OUTCOMES.COMPLETED),
            failed: outcome(RECEIPT_OUTCOMES.FAILED),
            cancelled: outcome(RECEIPT_OUTCOMES.CANCELLED),
            buyers: countDistinct(buyerIdentity),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .where(and(inRange(receipts.sellerReceivedAt, bounds), headlineReceipt))
        .groupBy(receipts.paid, sql`${sql.identifier('clientKind')}`),
    ),
  ];
}

const json = (path: string) => jsonField(observations.recordJson, path);
const FAILURE_EVENTS = [
  TELEMETRY_EVENTS.FAILED,
  TELEMETRY_EVENTS.REFUSED,
  TELEMETRY_EVENTS.UNSERVED,
];
// A failure's stop reason, else its code; a refusal's kind; none for unserved demand (or a record
// without one, so no row can fail the day).
const reason = sql<string>`coalesce(case ${observations.type}
  when ${literal(TELEMETRY_EVENTS.FAILED)} then coalesce(${json('reason')}, ${json('code')})
  when ${literal(TELEMETRY_EVENTS.REFUSED)} then ${json('refusal')}
  end, ${literal(BREAKDOWNS.noReason)})`;

function failuresRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
): BatchItem[] {
  const events: SQL = sql`${observations.type} in (${sql.join(
    FAILURE_EVENTS.map(literal),
    sql`, `,
  )})`;
  return [
    database
      .delete(aggFailuresDaily)
      .where(eq(aggFailuresDaily.day, bounds.day)),
    database.insert(aggFailuresDaily).select(
      database
        .select(
          ordered(aggFailuresDaily, {
            day: sql<string>`${bounds.day}`,
            side: envelopes.role,
            clientKind: envelopes.clientKind,
            event: observations.type,
            reason,
            events: sql<number>`count(*)`,
            buyers: sql<number>`count(distinct ${json('buyerNodeId')})`,
            ...versionFields(now),
          }),
        )
        .from(observations)
        .innerJoin(envelopes, observationJoin)
        .where(and(inRange(observations.at, bounds), events))
        .groupBy(
          envelopes.role,
          envelopes.clientKind,
          observations.type,
          sql`${sql.identifier('reason')}`,
        ),
    ),
  ];
}

// The day's breakdown rows, replaced.
export function breakdownRollups(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
): BatchItem[] {
  return [
    ...originRollup(database, bounds, now),
    ...failuresRollup(database, bounds, now),
  ];
}
