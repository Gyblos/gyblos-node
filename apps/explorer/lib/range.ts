// Owns the date range the page shows: a preset number of UTC days ending today, read from the `range`
// search parameter, and the collector query it maps to. Pure, no I/O.
import { RANGE, UNITS } from './constants';

export type RangeDays = (typeof RANGE.presets)[number];

export const WIDEST_RANGE = RANGE.presets.reduce<RangeDays>(
  (widest, days) => (days > widest ? days : widest),
  RANGE.defaultDays,
);

export type RangeSection = keyof typeof RANGE.sections;
export const RANGE_SECTIONS = Object.keys(RANGE.sections) as RangeSection[];

export const presetRange = (value: unknown): RangeDays | undefined => {
  const days = typeof value === 'string' ? Number(value) : Number.NaN;
  return RANGE.presets.find((preset) => preset === days);
};

// The preset the parameter names, or the default for anything else (missing, repeated, unknown).
export function parseRange(value: unknown): RangeDays {
  const days = typeof value === 'string' ? Number(value) : Number.NaN;
  return RANGE.presets.find((preset) => preset === days) ?? RANGE.defaultDays;
}

const utcDay = (ms: number) =>
  new Date(ms).toISOString().slice(0, RANGE.dayPrecision);

// The collector's inclusive `from`/`to` days for the last `days` UTC days ending on `now`'s day, or,
// `periodsBack` periods earlier, the span of the same length just before it (for a change).
export function rangeQuery(
  days: RangeDays,
  now: number,
  periodsBack = 0,
): string {
  const end = now - periodsBack * days * UNITS.msPerDay;
  const from = utcDay(end - (days - 1) * UNITS.msPerDay);
  return `?from=${from}&to=${utcDay(end)}`;
}
