// Owns the date range the page shows: a preset number of UTC days ending today, read from the `range`
// search parameter, and the collector query it maps to. Pure, no I/O.
import { RANGE, UNITS } from './constants';

export type RangeDays = (typeof RANGE.presets)[number];

// The preset the parameter names, or the default for anything else (missing, repeated, unknown).
export function parseRange(value: unknown): RangeDays {
  const days = typeof value === 'string' ? Number(value) : Number.NaN;
  return RANGE.presets.find((preset) => preset === days) ?? RANGE.defaultDays;
}

const utcDay = (ms: number) =>
  new Date(ms).toISOString().slice(0, RANGE.dayPrecision);

// The collector's inclusive `from`/`to` days for the last `days` UTC days ending on `now`'s day.
export function rangeQuery(days: RangeDays, now: number): string {
  const from = utcDay(now - (days - 1) * UNITS.msPerDay);
  return `?from=${from}&to=${utcDay(now)}`;
}
