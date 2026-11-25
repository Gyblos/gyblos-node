import { asc, between, count, min, sql, sum } from 'drizzle-orm';

import type { CollectorDatabase } from './d1-client';
import type { DayRange } from './days';
import {
  aggDays,
  aggDemandDaily,
  aggDirtyDays,
  firstSeen,
  observations,
} from './schema';

export const demandRequests = sql<number>`${aggDemandDaily.unserved} + ${aggDemandDaily.refusedBeforeSelection} + ${aggDemandDaily.connectFailed}`;

export const captureStartQueries = (orm: CollectorDatabase) =>
  [
    orm.select({ day: min(firstSeen.firstDay) }).from(firstSeen),
    orm.select({ at: min(observations.at) }).from(observations),
  ] as const;

export function coverageQueries(orm: CollectorDatabase, range: DayRange) {
  const dem = aggDemandDaily;
  return [
    orm
      .select({
        day: aggDays.day,
        cutoff: aggDays.cutoff,
        revision: aggDays.revision,
      })
      .from(aggDays)
      .where(between(aggDays.day, range.from, range.to)),
    orm
      .select({ day: aggDirtyDays.day })
      .from(aggDirtyDays)
      .where(between(aggDirtyDays.day, range.from, range.to)),
    ...captureStartQueries(orm),
    orm
      .select({
        day: dem.day,
        models: count(),
        total: sum(demandRequests).mapWith(Number),
      })
      .from(dem)
      .where(between(dem.day, range.from, range.to))
      .groupBy(dem.day)
      .orderBy(asc(dem.day)),
  ] as const;
}
