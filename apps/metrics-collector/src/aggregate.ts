// Owns the scheduled aggregation run. One scan batch marks the days whose raw rows changed since the
// previous scan (with an overlap), then each dirty day is recomputed in one transactional batch:
// readers see the old day or the new one, never a mix. Late data simply marks its day dirty again.
import { and, asc, countDistinct, eq, gte, inArray, sql } from 'drizzle-orm';

import { firstSeenUpserts } from './aggregate-first-seen';
import {
  blank,
  buyerIdentity,
  completedHeadline,
  conflictCount,
  dayBounds,
  dayOf,
  demandEvents,
  demandFields,
  headlineReceipt,
  inRange,
  modelKey,
  observationJoin,
  observedFields,
  ordered,
  receiptTotals,
  versionFields,
  type DayBounds,
} from './aggregate-sql';
import { AGG_STATE_ID, AGGREGATES } from './constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from './d1-client';
import {
  aggDemandDaily,
  aggDirtyDays,
  aggNetworkDaily,
  aggObservedDaily,
  aggSellerBuyersDaily,
  aggSellerDaily,
  aggSellerHourly,
  aggState,
  conflicts,
  envelopes,
  observations,
  receipts,
} from './schema';

export interface AggregationResult {
  // Days recomputed by this run, oldest first.
  days: string[];
  // Dirty days are left for the next run.
  more: boolean;
}

// Marks dirty every day touched since the previous scan, then moves the cursor, in one batch.
async function scan(database: CollectorDatabase, now: number) {
  const [state] = await database
    .select({ scannedAt: aggState.scannedAt })
    .from(aggState)
    .where(eq(aggState.id, AGG_STATE_ID));
  const since = (state?.scannedAt ?? 0) - AGGREGATES.scanOverlapMs;
  const mark = (day: ReturnType<typeof dayOf>) => ({ day });
  await database.batch([
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(
            ordered(aggDirtyDays, mark(dayOf(receipts.sellerReceivedAt))),
          )
          .from(receipts)
          .where(gte(receipts.updatedAt, since)),
      )
      .onConflictDoNothing(),
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(ordered(aggDirtyDays, mark(dayOf(observations.at))))
          .from(observations)
          .where(gte(observations.insertedAt, since)),
      )
      .onConflictDoNothing(),
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(
            ordered(aggDirtyDays, mark(dayOf(receipts.sellerReceivedAt))),
          )
          .from(conflicts)
          .innerJoin(receipts, eq(receipts.receiptKey, conflicts.receiptKey))
          .where(gte(conflicts.insertedAt, since)),
      )
      .onConflictDoNothing(),
    database
      .insert(aggState)
      .values({ id: AGG_STATE_ID, scannedAt: now })
      .onConflictDoUpdate({ target: aggState.id, set: { scannedAt: now } }),
  ]);
}

function sellerRollups(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  const group = [
    receipts.sellerNodeId,
    receipts.modelId,
    blank(receipts.variant),
    blank(receipts.quantization),
    receipts.paid,
  ];
  const model = {
    sellerNodeId: receipts.sellerNodeId,
    modelId: receipts.modelId,
    variant: blank(receipts.variant),
    quantization: blank(receipts.quantization),
  };
  const day = sql<string>`${bounds.day}`;
  const hour = sql<number>`${receipts.sellerReceivedAt} / ${sql.raw(String(AGGREGATES.hourMs))}`;
  const where = inRange(receipts.sellerReceivedAt, bounds);
  return [
    database.delete(aggSellerDaily).where(eq(aggSellerDaily.day, bounds.day)),
    database.insert(aggSellerDaily).select(
      database
        .select(
          ordered(aggSellerDaily, {
            day,
            ...model,
            ...receiptTotals(),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .where(where)
        .groupBy(...group),
    ),
    database
      .delete(aggSellerHourly)
      .where(inRange(aggSellerHourly.hour, hourBounds(bounds))),
    database.insert(aggSellerHourly).select(
      database
        .select(
          ordered(aggSellerHourly, {
            hour,
            ...model,
            ...receiptTotals(),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .where(where)
        .groupBy(hour, ...group),
    ),
    database
      .delete(aggSellerBuyersDaily)
      .where(eq(aggSellerBuyersDaily.day, bounds.day)),
    database.insert(aggSellerBuyersDaily).select(
      database
        .select(
          ordered(aggSellerBuyersDaily, {
            day,
            sellerNodeId: receipts.sellerNodeId,
            paid: receipts.paid,
            buyers: countDistinct(buyerIdentity),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .where(and(where, headlineReceipt))
        .groupBy(receipts.sellerNodeId, receipts.paid),
    ),
  ];
}
const hourBounds = (bounds: DayBounds): DayBounds => ({
  day: bounds.day,
  start: bounds.start / AGGREGATES.hourMs,
  end: bounds.end / AGGREGATES.hourMs,
});

function networkRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  const distinctWhere = (value: unknown, condition: unknown) =>
    sql<number>`count(distinct case when ${condition} then ${value} end)`;
  return [
    database.delete(aggNetworkDaily).where(eq(aggNetworkDaily.day, bounds.day)),
    database.insert(aggNetworkDaily).select(
      database
        .select(
          ordered(aggNetworkDaily, {
            day: sql<string>`${bounds.day}`,
            ...receiptTotals(),
            conflicts: conflictCount(bounds),
            activeSellers: distinctWhere(
              receipts.sellerNodeId,
              completedHeadline,
            ),
            buyers: distinctWhere(buyerIdentity, headlineReceipt),
            modelsServed: distinctWhere(modelKey, completedHeadline),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .where(inRange(receipts.sellerReceivedAt, bounds))
        .groupBy(receipts.paid),
    ),
  ];
}

function observationRollups(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  const day = sql<string>`${bounds.day}`;
  const where = inRange(observations.at, bounds);
  return [
    database
      .delete(aggObservedDaily)
      .where(eq(aggObservedDaily.day, bounds.day)),
    database.insert(aggObservedDaily).select(
      database
        .select(
          ordered(aggObservedDaily, {
            day,
            ...observedFields(),
            ...versionFields(now),
          }),
        )
        .from(observations)
        .innerJoin(envelopes, observationJoin)
        .where(where)
        .having(sql`count(*) > 0`),
    ),
    database.delete(aggDemandDaily).where(eq(aggDemandDaily.day, bounds.day)),
    database.insert(aggDemandDaily).select(
      database
        .select(
          ordered(aggDemandDaily, {
            day,
            modelId: observations.modelId,
            ...demandFields(),
            ...versionFields(now),
          }),
        )
        .from(observations)
        .innerJoin(envelopes, observationJoin)
        .where(and(where, demandEvents))
        .groupBy(observations.modelId),
    ),
  ];
}

// Every statement for one day, in one transactional batch; the day leaves the dirty set with it.
type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];
function dayBatch(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
): [BatchItem, ...BatchItem[]] {
  return [
    database.delete(aggDirtyDays).where(eq(aggDirtyDays.day, bounds.day)),
    ...sellerRollups(database, bounds, now),
    ...networkRollup(database, bounds, now),
    ...observationRollups(database, bounds, now),
    ...firstSeenUpserts(database, bounds),
  ];
}

export async function runAggregation(
  database: D1Database,
  now: number,
): Promise<AggregationResult> {
  const orm = createD1Orm(database);
  await scan(orm, now);
  const dirty = await orm
    .select({ day: aggDirtyDays.day })
    .from(aggDirtyDays)
    .orderBy(asc(aggDirtyDays.day))
    .limit(AGGREGATES.maxDaysPerRun + 1);
  const days: string[] = [];
  for (const { day } of dirty.slice(0, AGGREGATES.maxDaysPerRun)) {
    const bounds = dayBounds(day);
    // A day outside the calendar cannot come from strftime; drop it rather than loop on it.
    if (!bounds) {
      await orm.delete(aggDirtyDays).where(inArray(aggDirtyDays.day, [day]));
      continue;
    }
    await orm.batch(dayBatch(orm, bounds, now));
    days.push(day);
  }
  return { days, more: dirty.length > AGGREGATES.maxDaysPerRun };
}
