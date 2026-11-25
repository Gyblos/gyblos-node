import { and, eq, lte, min, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/sqlite-core';

import { COLLECTOR_ROUTES } from './constants';
import type { CollectorDatabase } from './d1-client';
import {
  aggChainDaily,
  aggDemandDaily,
  aggFailuresDaily,
  aggNetworkDaily,
  aggObservedDaily,
  aggOriginDaily,
  aggSellerDaily,
} from './schema';
import type { StatsResource } from './stats-store';

type DailyTable =
  | typeof aggChainDaily
  | typeof aggDemandDaily
  | typeof aggFailuresDaily
  | typeof aggNetworkDaily
  | typeof aggObservedDaily
  | typeof aggOriginDaily
  | typeof aggSellerDaily;

export async function firstPublicDay(
  orm: CollectorDatabase,
  resource: StatsResource,
  to: string,
  nodeId: string,
) {
  const oldest = (table: DailyTable, scope?: SQL) =>
    orm
      .select({ day: min(table.day) })
      .from(table)
      .where(and(lte(table.day, to), scope));
  const read = () => {
    switch (resource) {
      case COLLECTOR_ROUTES.STATS_NETWORK:
        return unionAll(
          oldest(aggNetworkDaily),
          oldest(aggObservedDaily),
          oldest(aggDemandDaily),
          oldest(aggOriginDaily),
          oldest(aggFailuresDaily),
        );
      case COLLECTOR_ROUTES.STATS_MODELS:
        return oldest(aggSellerDaily);
      case COLLECTOR_ROUTES.STATS_SELLER:
        return oldest(aggSellerDaily, eq(aggSellerDaily.sellerNodeId, nodeId));
      case COLLECTOR_ROUTES.STATS_CHAIN:
        return oldest(aggChainDaily);
    }
  };
  const rows = await read();
  return (
    rows
      .map((row) => row.day)
      .filter((day) => day !== null)
      .sort()[0] ?? null
  );
}
