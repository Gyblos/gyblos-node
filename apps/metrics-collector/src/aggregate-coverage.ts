import { between, sql } from 'drizzle-orm';

import { AGGREGATES } from './constants';
import type { CollectorDatabase } from './d1-client';
import { dayBounds, dayOfTime, daysOf, type DayBounds } from './days';
import { aggDays, aggDirtyDays } from './schema';
import { captureStartDay } from './stats-coverage';
import { captureStartQueries } from './stats-coverage-read';

export async function calendarMarks(database: CollectorDatabase, now: number) {
  const [receipts, events] = await Promise.all(captureStartQueries(database));
  const start = captureStartDay(receipts, events);
  const today = dayBounds(dayOfTime(now))!;
  const earliest = dayOfTime(
    today.start - (AGGREGATES.maxRangeDays - 1) * AGGREGATES.dayMs,
  );
  const to = dayOfTime(today.start - AGGREGATES.dayMs);
  if (!start) return [];
  const from = start > earliest ? start : earliest;
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
      cutoff: now,
      revision: 1,
    })
    .onConflictDoUpdate({
      target: aggDays.day,
      set: {
        cutoff: now,
        revision: sql`${aggDays.revision} + 1`,
      },
    });
