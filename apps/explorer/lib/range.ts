import { ALL_TIME, RANGE, UNITS } from './constants';

export type RangeDays = (typeof RANGE.presets)[number];

export const displayRange = (days: RangeDays) =>
  days === ALL_TIME
    ? 'all time'
    : days === 1
      ? 'last complete UTC day'
      : `last ${days} days`;

export const rangeValue = (days: RangeDays) =>
  days === 1 ? RANGE.dayParam : String(days);

export const rangeEnd = (days: RangeDays, now: number, closed = true) =>
  now - (days === 1 || closed ? UNITS.msPerDay : 0);

export const previousRange = (days: RangeDays) =>
  days === 1 ? 'previous UTC day' : `previous ${days} days`;

export type RangeSection = keyof typeof RANGE.sections;
export const RANGE_SECTIONS = Object.keys(RANGE.sections) as RangeSection[];

const RANGE_PARAMS = [
  RANGE.param,
  ...RANGE_SECTIONS.map((section) => RANGE.sections[section].param),
];

export function hasRangeAlias(read: (param: string) => unknown) {
  return RANGE_PARAMS.some((param) => {
    const value = read(param);
    return value === RANGE.legacyRange || value === '1';
  });
}

export const presetRange = (value: unknown): RangeDays | undefined =>
  value === RANGE.legacyRange
    ? ALL_TIME
    : RANGE.presets.find(
        (preset) => value === String(preset) || value === rangeValue(preset),
      );

// The preset the parameter names, or the default for anything else (missing, repeated, unknown).
export function parseRange(value: unknown): RangeDays {
  return presetRange(value) ?? RANGE.defaultDays;
}

const utcDay = (ms: number) =>
  new Date(ms).toISOString().slice(0, RANGE.dayPrecision);

// The collector's inclusive `from`/`to` days for the last `days` UTC days ending on `now`'s day, or,
// `periodsBack` periods earlier, the span of the same length just before it (for a change).
export function rangeQuery(days: number, now: number, periodsBack = 0): string {
  const end = now - periodsBack * days * UNITS.msPerDay;
  const from = utcDay(end - (days - 1) * UNITS.msPerDay);
  return `?from=${from}&to=${utcDay(end)}`;
}

export function overviewWindow(days: number, now: number, periodsBack = 0) {
  return Array.from({ length: days }, (_, index) =>
    utcDay(now - ((periodsBack + 1) * days - index) * UNITS.msPerDay),
  );
}
