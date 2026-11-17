// Owns the public stats reads: typed, set-based selects over aggregate tables only, never raw rows.
// Each endpoint is a fixed number of statements for any day range; histograms are summed bucket by
// bucket in SQL, so a range costs one grouped scan per table.
import {
  and,
  asc,
  between,
  countDistinct,
  desc,
  eq,
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
import {
  aggDemandDaily,
  aggNetworkDaily,
  aggObservedDaily,
  aggSellerBuyersDaily,
  aggSellerDaily,
} from './schema';

export interface DayRange {
  from: string;
  to: string;
}
// Summed bucket counts of a histogram column, as a JSON array text.
function histogramSum(column: SQLiteColumn) {
  const parts = Array.from(
    { length: AGGREGATES.latencyBucketsMs.length + 1 },
    (_, index) =>
      sql`coalesce(sum(json_extract(${column}, ${sql.raw(`'$[${index}]'`)})), 0)`,
  );
  return sql<string>`json_array(${sql.join(parts, sql`, `)})`;
}
const sum = (column: SQLiteColumn) => sql<number>`coalesce(sum(${column}), 0)`;

type Totals = typeof aggSellerDaily | typeof aggNetworkDaily;
// Additive receipt totals of a seller or network table, summed over the grouped rows.
function totals(table: Totals) {
  return {
    paid: table.paid,
    bilateral: sum(table.bilateral),
    sellerOnly: sum(table.sellerOnly),
    disputed: sum(table.disputed),
    completed: sum(table.completed),
    failed: sum(table.failed),
    cancelled: sum(table.cancelled),
    inputTokens: sum(table.inputTokens),
    outputTokens: sum(table.outputTokens),
    reasoningTokens: sum(table.reasoningTokens),
    reasoningUnknown: sum(table.reasoningUnknown),
    amountAtomic: sum(table.amountAtomic),
    feeAtomic: sum(table.feeAtomic),
    firstTokenHist: histogramSum(table.firstTokenHist),
    totalHist: histogramSum(table.totalHist),
    aggregatedAt: sql<number>`max(${table.aggregatedAt})`,
  };
}
export type TotalsRow = Awaited<
  ReturnType<typeof readNetwork>
>['network'][number];

const within = (column: SQLiteColumn, range: DayRange): SQL =>
  between(column, range.from, range.to);

export function statsReader(database: D1Database) {
  const orm = createD1Orm(database);
  return {
    network: (range: DayRange) => readNetwork(orm, range),
    models: (range: DayRange) => readModels(orm, range),
    seller: (nodeId: string, range: DayRange) => readSeller(orm, nodeId, range),
  };
}
export type StatsReader = ReturnType<typeof statsReader>;

async function readNetwork(orm: CollectorDatabase, range: DayRange) {
  const [network, observed, demand] = await orm.batch([
    orm
      .select({
        day: aggNetworkDaily.day,
        ...totals(aggNetworkDaily),
        conflicts: sum(aggNetworkDaily.conflicts),
        activeSellers: sum(aggNetworkDaily.activeSellers),
        buyers: sum(aggNetworkDaily.buyers),
        modelsServed: sum(aggNetworkDaily.modelsServed),
      })
      .from(aggNetworkDaily)
      .where(within(aggNetworkDaily.day, range))
      .groupBy(aggNetworkDaily.day, aggNetworkDaily.paid)
      .orderBy(asc(aggNetworkDaily.day), asc(aggNetworkDaily.paid)),
    orm
      .select()
      .from(aggObservedDaily)
      .where(within(aggObservedDaily.day, range))
      .orderBy(asc(aggObservedDaily.day)),
    orm
      .select()
      .from(aggDemandDaily)
      .where(within(aggDemandDaily.day, range))
      .orderBy(asc(aggDemandDaily.day), desc(aggDemandDaily.unserved)),
  ]);
  return { network, observed, demand };
}

async function readModels(orm: CollectorDatabase, range: DayRange) {
  const t = aggSellerDaily;
  return orm
    .select({
      modelId: t.modelId,
      variant: t.variant,
      quantization: t.quantization,
      ...totals(t),
      sellers: countDistinct(t.sellerNodeId),
    })
    .from(t)
    .where(within(t.day, range))
    .groupBy(t.modelId, t.variant, t.quantization, t.paid)
    .orderBy(desc(sum(t.completed)), asc(t.modelId));
}

async function readSeller(
  orm: CollectorDatabase,
  nodeId: string,
  range: DayRange,
) {
  const t = aggSellerDaily;
  const mine = and(eq(t.sellerNodeId, nodeId), within(t.day, range));
  const [days, models, buyers] = await orm.batch([
    orm
      .select({ day: t.day, ...totals(t) })
      .from(t)
      .where(mine)
      .groupBy(t.day, t.paid)
      .orderBy(asc(t.day), asc(t.paid)),
    orm
      .select({
        modelId: t.modelId,
        variant: t.variant,
        quantization: t.quantization,
        ...totals(t),
      })
      .from(t)
      .where(mine)
      .groupBy(t.modelId, t.variant, t.quantization, t.paid)
      .orderBy(desc(sum(t.completed)), asc(t.modelId)),
    orm
      .select({
        day: aggSellerBuyersDaily.day,
        paid: aggSellerBuyersDaily.paid,
        buyers: aggSellerBuyersDaily.buyers,
      })
      .from(aggSellerBuyersDaily)
      .where(
        and(
          eq(aggSellerBuyersDaily.sellerNodeId, nodeId),
          within(aggSellerBuyersDaily.day, range),
        ),
      )
      .orderBy(asc(aggSellerBuyersDaily.day)),
  ]);
  return { days, models, buyers };
}
