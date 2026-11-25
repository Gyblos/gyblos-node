import { asc, between, count, min, sql, sum } from 'drizzle-orm';

import type { CollectorDatabase } from './d1-client';
import { dayBounds, daysOf, type DayRange } from './days';
import { aggDays, aggDemandDaily, aggDirtyDays, firstSeen } from './schema';

export const COVERAGE_STATES = {
  FINAL: 'final',
  PARTIAL: 'partial',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
} as const;
export type CoverageState =
  (typeof COVERAGE_STATES)[keyof typeof COVERAGE_STATES];

export interface DayCoverage {
  state: CoverageState;
  cutoff: number | null;
  revision: number | null;
}
export interface CoverageRows {
  days: { day: string; cutoff: number; revision: number }[];
  pending: { day: string }[];
  start: { day: string | null }[];
  demand: { day: string; models: number; total: number | null }[];
}

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
    orm.select({ day: min(firstSeen.firstDay) }).from(firstSeen),
    orm
      .select({
        day: dem.day,
        models: count(),
        total: sum(
          sql<number>`${dem.unserved} + ${dem.refusedBeforeSelection} + ${dem.connectFailed}`,
        ).mapWith(Number),
      })
      .from(dem)
      .where(between(dem.day, range.from, range.to))
      .groupBy(dem.day)
      .orderBy(asc(dem.day)),
  ] as const;
}

export function dayCoverage(
  rows: CoverageRows,
  range: DayRange,
  today: string,
) {
  const computed = new Map(rows.days.map((row) => [row.day, row]));
  const pending = new Set(rows.pending.map((row) => row.day));
  const start = rows.start[0]?.day ?? null;
  const demand = new Map(rows.demand.map((row) => [row.day, row]));
  const days = daysOf(range).map((day) => {
    const row = computed.get(day);
    const state =
      start === null || day < start
        ? COVERAGE_STATES.UNKNOWN
        : pending.has(day)
          ? COVERAGE_STATES.PENDING
          : day >= today
            ? COVERAGE_STATES.PARTIAL
            : row && row.cutoff >= dayBounds(day)!.end
              ? COVERAGE_STATES.FINAL
              : COVERAGE_STATES.PENDING;
    return {
      day,
      coverage: {
        state,
        cutoff: row?.cutoff ?? null,
        revision: row?.revision ?? null,
      } satisfies DayCoverage,
      demandModels: demand.get(day)?.models ?? 0,
      demandTotal: demand.get(day)?.total ?? 0,
    };
  });
  let completeThrough: string | null = null;
  for (const { day, coverage } of days) {
    if (coverage.state === COVERAGE_STATES.UNKNOWN && completeThrough === null)
      continue;
    if (coverage.state !== COVERAGE_STATES.FINAL) break;
    completeThrough = day;
  }
  return { days, completeThrough };
}
