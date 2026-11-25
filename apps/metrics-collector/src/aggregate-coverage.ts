import { between, min, sql } from 'drizzle-orm';

import { AGGREGATES } from './constants';
import type { CollectorDatabase } from './d1-client';
import { dayBounds, dayOfTime, daysOf, type DayBounds } from './days';
import { aggDays, aggDirtyDays, firstSeen } from './schema';

export async function calendarMarks(database: CollectorDatabase, now: number) {
  const [start] = await database
    .select({ day: min(firstSeen.firstDay) })
    .from(firstSeen);
  const today = dayBounds(dayOfTime(now))!;
  const earliest = dayOfTime(
    today.start - (AGGREGATES.maxRangeDays - 1) * AGGREGATES.dayMs,
  );
  const to = dayOfTime(today.start - AGGREGATES.dayMs);
  if (!start?.day) return [];
  const from = start.day > earliest ? start.day : earliest;
  if (from > to) return [];
  const rows = await database
    .select({ day: aggDays.day, cutoff: aggDays.cutoff })
    .from(aggDays)
    .where(between(aggDays.day, from, to));
  const closed = new Set(
    rows
      .filter((row) => row.cutoff >= (dayBounds(row.day)?.end ?? Infinity))
      .map((row) => row.day),
  );
  const open = daysOf({ from, to }).filter((day) => !closed.has(day));
  return open.length
    ? [
        database
          .insert(aggDirtyDays)
          .values(open.map((day) => ({ day })))
          .onConflictDoNothing(),
      ]
    : [];
}

export const coverageUpsert = (
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) =>
  database
    .insert(aggDays)
    .values({
      day: bounds.day,
      formulaVersion: AGGREGATES.formulaVersion,
      cutoff: now,
      revision: 1,
    })
    .onConflictDoUpdate({
      target: aggDays.day,
      set: {
        formulaVersion: AGGREGATES.formulaVersion,
        cutoff: now,
        revision: sql`${aggDays.revision} + 1`,
      },
    });
