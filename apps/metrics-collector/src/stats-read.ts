// Owns the D1 adapter of the stats read port: typed, set-based selects over aggregate tables only,
// never raw rows. Each answer is one batch with a fixed number of statements for any day range;
// histograms are summed in SQL and list sizes are capped in SQL with window functions.
import {
  and,
  asc,
  between,
  countDistinct,
  desc,
  eq,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { AGGREGATES } from './constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from './d1-client';
import type { DayRange } from './days';
import {
  aggChainDaily,
  aggDemandDaily,
  aggFailuresDaily,
  aggModelObservedDaily,
  aggNetworkDaily,
  aggObservedDaily,
  aggOriginDaily,
  aggSellerBuyersDaily,
  aggSellerDaily,
  chainCursor,
} from './schema';
import {
  HISTOGRAM_KEYS,
  RECEIPT_TOTAL_KEYS,
  type ReceiptTotalKey,
  type ReceiptTotals,
} from './schema-aggregates';
import { histogramSum, total } from './sql-primitives';
import type { StatsReader } from './stats-store';

type TotalsTable = typeof aggSellerDaily | typeof aggNetworkDaily;
// Each summed field keeps its schema type: numbers stay numbers, histograms stay JSON text.
type SummedTotals = {
  [K in ReceiptTotalKey]: K extends 'paid'
    ? TotalsTable['paid']
    : SQL<ReceiptTotals[K]>;
};
// The receipt totals of a seller or network table, summed over the grouped rows: the paid flag is a
// group column, histograms are summed bucket by bucket, everything else is added.
function totals(table: TotalsTable) {
  const fields = Object.fromEntries(
    RECEIPT_TOTAL_KEYS.map((key) => [
      key,
      key === 'paid'
        ? table.paid
        : HISTOGRAM_KEYS.has(key)
          ? histogramSum(table[key])
          : total(table[key]),
    ]),
  ) as SummedTotals;
  return {
    ...fields,
    aggregatedAt: sql<number | null>`max(${table.aggregatedAt})`,
    minFormulaVersion: sql<number | null>`min(${table.formulaVersion})`,
    maxFormulaVersion: sql<number | null>`max(${table.formulaVersion})`,
  };
}
const within = (column: SQLiteColumn, range: DayRange) =>
  between(column, range.from, range.to);
const modelColumns = (table: typeof aggSellerDaily) =>
  [table.modelId, table.variant, table.quantization] as const;

function network(orm: CollectorDatabase, range: DayRange) {
  const net = aggNetworkDaily;
  const dem = aggDemandDaily;
  // The largest demand rows of each day, in SQL.
  const ranked = orm
    .select({
      day: dem.day,
      modelId: dem.modelId,
      unserved: dem.unserved,
      refusedBeforeSelection: dem.refusedBeforeSelection,
      connectFailed: dem.connectFailed,
      formulaVersion: dem.formulaVersion,
      aggregatedAt: dem.aggregatedAt,
      rank: sql<number>`row_number() over (partition by ${dem.day} order by ${dem.unserved} + ${dem.refusedBeforeSelection} + ${dem.connectFailed} desc, ${dem.modelId})`.as(
        'rank',
      ),
    })
    .from(dem)
    .where(within(dem.day, range))
    .as('ranked');
  const demand = {
    day: ranked.day,
    modelId: ranked.modelId,
    unserved: ranked.unserved,
    refusedBeforeSelection: ranked.refusedBeforeSelection,
    connectFailed: ranked.connectFailed,
    formulaVersion: ranked.formulaVersion,
    aggregatedAt: ranked.aggregatedAt,
  };
  return orm.batch([
    orm
      .select({
        day: net.day,
        ...totals(net),
        conflicts: total(net.conflicts),
        activeSellers: total(net.activeSellers),
        buyers: total(net.buyers),
        modelsServed: total(net.modelsServed),
      })
      .from(net)
      .where(within(net.day, range))
      .groupBy(net.day, net.paid)
      .orderBy(asc(net.day), asc(net.paid)),
    orm
      .select()
      .from(aggObservedDaily)
      .where(within(aggObservedDaily.day, range))
      .orderBy(asc(aggObservedDaily.day)),
    orm
      .select(demand)
      .from(ranked)
      .where(lte(ranked.rank, AGGREGATES.maxPublicDemandPerDay))
      .orderBy(asc(ranked.day), asc(ranked.rank)),
    orm
      .select()
      .from(aggOriginDaily)
      .where(within(aggOriginDaily.day, range))
      .orderBy(
        asc(aggOriginDaily.day),
        asc(aggOriginDaily.paid),
        asc(aggOriginDaily.clientKind),
      ),
    orm
      .select()
      .from(aggFailuresDaily)
      .where(within(aggFailuresDaily.day, range))
      .orderBy(
        asc(aggFailuresDaily.day),
        desc(aggFailuresDaily.events),
        asc(aggFailuresDaily.side),
        asc(aggFailuresDaily.clientKind),
        asc(aggFailuresDaily.event),
        asc(aggFailuresDaily.reason),
      ),
  ]);
}

// Only the AGGREGATES.maxPublicModels models with the most completed requests (free and paid
// together) under `condition`; an uncorrelated subquery, so the cap counts models, not rows.
function topModels(orm: CollectorDatabase, condition: SQL | undefined) {
  const daily = aggSellerDaily;
  const top = orm
    .select({
      modelId: daily.modelId,
      variant: daily.variant,
      quantization: daily.quantization,
    })
    .from(daily)
    .where(condition)
    .groupBy(...modelColumns(daily))
    .orderBy(desc(total(daily.completed)), ...modelColumns(daily).map(asc))
    .limit(AGGREGATES.maxPublicModels);
  return sql`(${daily.modelId}, ${daily.variant}, ${daily.quantization}) in ${top}`;
}
// Most completed first, free and paid of one model together.
const byModelCompleted = (daily: typeof aggSellerDaily) => [
  desc(
    sql`sum(sum(${daily.completed})) over (partition by ${daily.modelId}, ${daily.variant}, ${daily.quantization})`,
  ),
  ...modelColumns(daily).map(asc),
  asc(daily.paid),
];

function models(orm: CollectorDatabase, range: DayRange) {
  const daily = aggSellerDaily;
  const inRange = within(daily.day, range);
  const seen = aggModelObservedDaily;
  return orm.batch([
    modelTotals(orm, inRange),
    orm
      .select({
        modelId: seen.modelId,
        variant: seen.variant,
        quantization: seen.quantization,
        paid: seen.paid,
        buyerFirstTokenHist: histogramSum(seen.buyerFirstTokenHist),
        engineTpsHist: histogramSum(
          seen.engineTpsHist,
          AGGREGATES.tokensPerSecondBuckets,
        ),
      })
      .from(seen)
      .where(within(seen.day, range))
      .groupBy(seen.modelId, seen.variant, seen.quantization, seen.paid),
  ]);
}
function modelTotals(orm: CollectorDatabase, inRange: SQL | undefined) {
  const daily = aggSellerDaily;
  return orm
    .select({
      ...totals(daily),
      modelId: daily.modelId,
      variant: daily.variant,
      quantization: daily.quantization,
      sellers: countDistinct(daily.sellerNodeId),
    })
    .from(daily)
    .where(and(inRange, topModels(orm, inRange)))
    .groupBy(...modelColumns(daily), daily.paid)
    .orderBy(...byModelCompleted(daily));
}

function seller(orm: CollectorDatabase, nodeId: string, range: DayRange) {
  const daily = aggSellerDaily;
  const buyersTable = aggSellerBuyersDaily;
  const mine = and(eq(daily.sellerNodeId, nodeId), within(daily.day, range));
  return orm.batch([
    orm
      .select({ day: daily.day, ...totals(daily) })
      .from(daily)
      .where(mine)
      .groupBy(daily.day, daily.paid)
      .orderBy(asc(daily.day), asc(daily.paid)),
    orm
      .select({
        ...totals(daily),
        modelId: daily.modelId,
        variant: daily.variant,
        quantization: daily.quantization,
      })
      .from(daily)
      .where(and(mine, topModels(orm, mine)))
      .groupBy(...modelColumns(daily), daily.paid)
      .orderBy(...byModelCompleted(daily)),
    orm
      .select({
        day: buyersTable.day,
        paid: buyersTable.paid,
        buyers: buyersTable.buyers,
      })
      .from(buyersTable)
      .where(
        and(
          eq(buyersTable.sellerNodeId, nodeId),
          within(buyersTable.day, range),
        ),
      )
      .orderBy(asc(buyersTable.day), asc(buyersTable.paid)),
  ]);
}

function chain(orm: CollectorDatabase, range: DayRange) {
  return orm.batch([
    orm
      .select()
      .from(aggChainDaily)
      .where(within(aggChainDaily.day, range))
      .orderBy(asc(aggChainDaily.day), asc(aggChainDaily.scope)),
    orm
      .select({
        backfillDone: chainCursor.backfillDone,
        updatedAt: chainCursor.updatedAt,
      })
      .from(chainCursor)
      .limit(1),
  ]);
}

export function statsReader(database: D1Database): StatsReader {
  const orm = createD1Orm(database);
  return {
    async network(range) {
      const [networkRows, observed, demand, origins, failures] = await network(
        orm,
        range,
      );
      return { network: networkRows, observed, demand, origins, failures };
    },
    async models(range) {
      const [rows, observed] = await models(orm, range);
      return { models: rows, observed };
    },
    async seller(nodeId, range) {
      const [days, sellerModels, buyers] = await seller(orm, nodeId, range);
      return { days, models: sellerModels, buyers };
    },
    async chain(range) {
      const [days, [cursor]] = await chain(orm, range);
      return {
        days,
        index: cursor
          ? {
              backfillDone: cursor.backfillDone === 1,
              updatedAt: cursor.updatedAt,
            }
          : null,
      };
    },
  };
}
