// Owns the scheduled aggregation run. One scan batch marks dirty the days whose raw rows changed since
// the previous scan (with an overlap) or whose aggregates use an older formula version; then each
// dirty day, newest first, is recomputed in one transactional batch, so readers see the old day or the
// new one, never a mix. A day that fails stays dirty and never blocks the others.
import {
  and,
  countDistinct,
  desc,
  eq,
  gte,
  isNotNull,
  ne,
  sql,
} from 'drizzle-orm';

import { firstSeenUpserts } from './aggregate-first-seen';
import {
  blank,
  buyerIdentity,
  completedHeadline,
  conflictCount,
  demandEvents,
  demandFields,
  headlineReceipt,
  modelKey,
  observationJoin,
  observedFields,
  receiptTotalsSelect,
  versionFields,
} from './aggregate-sql';
import { AGG_STATE_ID, AGGREGATES } from './constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from './d1-client';
import { dayBounds, type DayBounds } from './days';
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
import { dayOf, distinctWhere, inRange, ordered } from './sql-primitives';

export interface AggregationResult {
  // Days recomputed by this run, newest first.
  days: string[];
  // Days whose batch failed; they stay dirty for the next run.
  failed: string[];
  // Dirty days are left for the next run.
  more: boolean;
}
type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];

// Marks dirty every day touched since the previous scan, or aggregated with an older formula, and
// moves the cursor, in one batch.
async function scan(database: CollectorDatabase, now: number) {
  const [state] = await database
    .select({ scannedAt: aggState.scannedAt })
    .from(aggState)
    .where(eq(aggState.id, AGG_STATE_ID));
  const since = (state?.scannedAt ?? 0) - AGGREGATES.scanOverlapMs;
  const receiptDay = dayOf(receipts.sellerReceivedAt);
  const observationDay = dayOf(observations.at);
  const day = (value: ReturnType<typeof dayOf>) =>
    ordered(aggDirtyDays, { day: value });
  await database.batch([
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(receiptDay))
          .from(receipts)
          .where(and(gte(receipts.updatedAt, since), isNotNull(receiptDay))),
      )
      .onConflictDoNothing(),
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(observationDay))
          .from(observations)
          .where(
            and(gte(observations.insertedAt, since), isNotNull(observationDay)),
          ),
      )
      .onConflictDoNothing(),
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(receiptDay))
          .from(conflicts)
          .innerJoin(receipts, eq(receipts.receiptKey, conflicts.receiptKey))
          .where(and(gte(conflicts.insertedAt, since), isNotNull(receiptDay))),
      )
      .onConflictDoNothing(),
    // A formula change: every day aggregated with another version is recomputed.
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(sql<string>`${aggSellerDaily.day}`))
          .from(aggSellerDaily)
          .where(ne(aggSellerDaily.formulaVersion, AGGREGATES.formulaVersion)),
      )
      .onConflictDoNothing(),
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(sql<string>`${aggObservedDaily.day}`))
          .from(aggObservedDaily)
          .where(
            ne(aggObservedDaily.formulaVersion, AGGREGATES.formulaVersion),
          ),
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
  const model = {
    sellerNodeId: receipts.sellerNodeId,
    modelId: receipts.modelId,
    variant: blank(receipts.variant),
    quantization: blank(receipts.quantization),
  };
  const group = [...Object.values(model), receipts.paid];
  const day = sql<string>`${bounds.day}`;
  const hour = sql<number>`${receipts.sellerReceivedAt} / ${sql.raw(String(AGGREGATES.hourMs))}`;
  // The day's epoch hours, [start, end).
  const hours = {
    start: bounds.start / AGGREGATES.hourMs,
    end: bounds.end / AGGREGATES.hourMs,
  };
  const where = inRange(receipts.sellerReceivedAt, bounds);
  const totals = { ...receiptTotalsSelect(), ...versionFields(now) };
  return [
    database.delete(aggSellerDaily).where(eq(aggSellerDaily.day, bounds.day)),
    database.insert(aggSellerDaily).select(
      database
        .select(ordered(aggSellerDaily, { day, ...model, ...totals }))
        .from(receipts)
        .where(where)
        .groupBy(...group),
    ),
    database
      .delete(aggSellerHourly)
      .where(inRange(aggSellerHourly.hour, hours)),
    database.insert(aggSellerHourly).select(
      database
        .select(ordered(aggSellerHourly, { hour, ...model, ...totals }))
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

function networkRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  return [
    database.delete(aggNetworkDaily).where(eq(aggNetworkDaily.day, bounds.day)),
    database.insert(aggNetworkDaily).select(
      database
        .select(
          ordered(aggNetworkDaily, {
            day: sql<string>`${bounds.day}`,
            ...receiptTotalsSelect(),
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
export function dayBatch(
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
  // Newest first: today's numbers are never starved by old days marked dirty.
  const dirty = await orm
    .select({ day: aggDirtyDays.day })
    .from(aggDirtyDays)
    .orderBy(desc(aggDirtyDays.day))
    .limit(AGGREGATES.maxDaysPerRun + 1);
  const result: AggregationResult = {
    days: [],
    failed: [],
    more: dirty.length > AGGREGATES.maxDaysPerRun,
  };
  for (const { day } of dirty.slice(0, AGGREGATES.maxDaysPerRun)) {
    const bounds = dayBounds(day);
    try {
      // A day outside the calendar cannot come from strftime; drop it rather than keep it dirty.
      if (!bounds)
        await orm.delete(aggDirtyDays).where(eq(aggDirtyDays.day, day));
      else {
        await orm.batch(dayBatch(orm, bounds, now));
        result.days.push(day);
      }
    } catch {
      result.failed.push(day);
    }
  }
  return result;
}
