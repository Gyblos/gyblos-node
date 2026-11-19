// Owns the scheduled aggregation run. One scan batch marks dirty the days whose raw rows (receipts,
// observations, conflicts) changed since the previous scan (with an overlap) or whose aggregates use
// an older formula version; then each dirty day, newest first, is recomputed in
// one transactional batch, so readers see the old day or the new one, never a mix. Chain days follow,
// with their own scan and dirty set (aggregate-chain.ts). A day that fails stays dirty and never blocks the others.
import {
  and,
  countDistinct,
  desc,
  eq,
  gte,
  isNotNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';

import { breakdownRollups } from './aggregate-breakdowns';
import {
  runChainAggregation,
  type ChainAggregationResult,
} from './aggregate-chain-run';
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
  modelObservedEvents,
  modelObservedFields,
  observationJoin,
  observedFields,
  receiptOfObservation,
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
  aggModelObservedDaily,
  aggNetworkDaily,
  aggObservedDaily,
  aggOriginDaily,
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
  // The chain days, scanned and recomputed after and apart from the receipt days.
  chain: ChainAggregationResult;
}
type BatchItem = Parameters<CollectorDatabase['batch']>[0][number];

type BatchItems = [BatchItem, ...BatchItem[]];
// Days aggregated with another formula version, re-marked once after a formula change.
function staleVersionMarks(
  database: CollectorDatabase,
  day: (value: ReturnType<typeof dayOf>) => { day: SQL.Aliased<string> },
): BatchItem[] {
  return [
    aggSellerDaily,
    aggObservedDaily,
    aggOriginDaily,
    aggModelObservedDaily,
  ].map((table) =>
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(sql<string>`${table.day}`))
          .from(table)
          .where(ne(table.formulaVersion, AGGREGATES.formulaVersion)),
      )
      .onConflictDoNothing(),
  );
}

// Marks dirty every day touched since the previous scan (and, after a formula change, every day
// aggregated with another version), and moves the cursor, in one batch.
async function scan(database: CollectorDatabase, now: number) {
  const [state] = await database
    .select({
      scannedAt: aggState.scannedAt,
      formulaVersion: aggState.formulaVersion,
    })
    .from(aggState)
    .where(eq(aggState.id, AGG_STATE_ID));
  const since = (state?.scannedAt ?? 0) - AGGREGATES.scanOverlapMs;
  const receiptDay = dayOf(receipts.sellerReceivedAt);
  const observationDay = dayOf(observations.at);
  const day = (value: ReturnType<typeof dayOf>) =>
    ordered(aggDirtyDays, { day: value });
  const changed =
    state !== undefined && state.formulaVersion !== AGGREGATES.formulaVersion;
  const cursor = { scannedAt: now, formulaVersion: AGGREGATES.formulaVersion };
  const batch: BatchItems = [
    database
      .insert(aggState)
      .values({ id: AGG_STATE_ID, ...cursor })
      .onConflictDoUpdate({ target: aggState.id, set: cursor }),
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
    // Per-model observations fall on their receipt's day, which may differ from the event's own.
    database
      .insert(aggDirtyDays)
      .select(
        database
          .selectDistinct(day(receiptDay))
          .from(observations)
          .innerJoin(receipts, receiptOfObservation)
          .where(
            and(gte(observations.insertedAt, since), isNotNull(receiptDay)),
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
    ...(changed ? staleVersionMarks(database, day) : []),
  ];
  await database.batch(batch);
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

// Per model and paid flag, on the day of the receipt each event belongs to.
function modelObservedRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  const model = {
    modelId: receipts.modelId,
    variant: blank(receipts.variant),
    quantization: blank(receipts.quantization),
  };
  return [
    database
      .delete(aggModelObservedDaily)
      .where(eq(aggModelObservedDaily.day, bounds.day)),
    database.insert(aggModelObservedDaily).select(
      database
        .select(
          ordered(aggModelObservedDaily, {
            day: sql<string>`${bounds.day}`,
            ...model,
            paid: receipts.paid,
            ...modelObservedFields(),
            ...versionFields(now),
          }),
        )
        .from(receipts)
        .innerJoin(observations, receiptOfObservation)
        .innerJoin(envelopes, observationJoin)
        .where(
          and(inRange(receipts.sellerReceivedAt, bounds), modelObservedEvents),
        )
        .groupBy(...Object.values(model), receipts.paid),
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
    ...modelObservedRollup(database, bounds, now),
    ...firstSeenUpserts(database, bounds),
    ...breakdownRollups(database, bounds, now),
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
  const result: Omit<AggregationResult, 'chain'> = {
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
  return { ...result, chain: await runChainAggregation(orm, now) };
}
