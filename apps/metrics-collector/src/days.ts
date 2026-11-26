// Owns UTC day arithmetic for aggregates and the public stats ranges. Days are `YYYY-MM-DD`; a range
// is inclusive. Pure functions, no I/O.
import { AGGREGATES } from './constants';

// A UTC day with its [start, end) in epoch ms.
export interface DayBounds {
  day: string;
  start: number;
  end: number;
}
// An inclusive range of UTC days.
export interface DayRange {
  from: string;
  to: string;
  range?: typeof AGGREGATES.allTimeRange;
  historyAvailable?: boolean;
}
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = 'T00:00:00.000Z';

// The UTC day's bounds, or undefined for a malformed or impossible day (2026-02-30).
export function dayBounds(day: string): DayBounds | undefined {
  if (!DAY_PATTERN.test(day)) return undefined;
  const start = Date.parse(`${day}${ISO_TIME}`);
  if (
    !Number.isFinite(start) ||
    !new Date(start).toISOString().startsWith(`${day}T`)
  )
    return undefined;
  return { day, start, end: start + AGGREGATES.dayMs };
}
// The UTC day holding an epoch ms time.
export const dayOfTime = (at: number) =>
  new Date(at).toISOString().split('T')[0]!;

// The requested range: `to` defaults to today and `from` to the start of the default window. Undefined
// when malformed, impossible, reversed, or longer than AGGREGATES.maxRangeDays days (inclusive).
export function dayRange(
  from: string | undefined,
  to: string | undefined,
  now: number,
): DayRange | undefined {
  const end = dayBounds(to ?? dayOfTime(now));
  if (!end) return undefined;
  const start = dayBounds(
    from ??
      dayOfTime(
        end.start - (AGGREGATES.defaultRangeDays - 1) * AGGREGATES.dayMs,
      ),
  );
  if (!start || start.start > end.start) return undefined;
  const days = (end.start - start.start) / AGGREGATES.dayMs + 1;
  return days > AGGREGATES.maxRangeDays
    ? undefined
    : { from: start.day, to: end.day };
}

// Every day of a range, oldest first.
export function daysOf(range: DayRange): string[] {
  const days: string[] = [];
  const last = Date.parse(`${range.to}${ISO_TIME}`);
  for (
    let at = Date.parse(`${range.from}${ISO_TIME}`);
    at <= last;
    at += AGGREGATES.dayMs
  )
    days.push(dayOfTime(at));
  return days;
}
