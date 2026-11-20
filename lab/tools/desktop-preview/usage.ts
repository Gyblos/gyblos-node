// Calendar periods follow the local timezone used by the preview's date labels.
import { PREVIEW } from './constants';

export const USAGE_PERIOD = {
  DAY: 'Today',
  WEEK: 'This week',
  MONTH: 'This month',
  HALF: 'This half-year',
  YEAR: 'This year',
  ALL: 'All time',
} as const;

export type UsagePeriod = (typeof USAGE_PERIOD)[keyof typeof USAGE_PERIOD];
export type UsageSource = 'Chat' | 'API';
export type UsageEvent = {
  id: string;
  title: string;
  source: UsageSource;
  at: number;
  tokens: number | null;
  open?: () => void;
};
type UsageRow = Omit<UsageEvent, 'tokens'> & {
  tokens: number;
  count: number;
  measured: number;
};

function startOfPeriod(period: UsagePeriod, now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (period) {
    case USAGE_PERIOD.ALL:
      return 0;
    case USAGE_PERIOD.YEAR:
      start.setMonth(0, 1);
      break;
    case USAGE_PERIOD.HALF:
      start.setMonth(
        start.getMonth() < PREVIEW.halfYearMonths ? 0 : PREVIEW.halfYearMonths,
        1,
      );
      break;
    case USAGE_PERIOD.MONTH:
      start.setDate(1);
      break;
    case USAGE_PERIOD.WEEK:
      start.setDate(
        start.getDate() -
          ((start.getDay() + PREVIEW.weekDays - 1) % PREVIEW.weekDays),
      );
      break;
  }
  return start.getTime();
}

function summarize(events: readonly UsageEvent[], start: number, now: number) {
  const rows = new Map<string, UsageRow>();
  const totals = { Chat: 0, API: 0, tokens: 0, measured: 0 };
  for (const event of events) {
    if (event.at < start || event.at > now) continue;
    const key = event.source + ':' + event.id;
    const row = rows.get(key) ?? { ...event, count: 0, measured: 0, tokens: 0 };
    row.count++;
    row.at = Math.max(row.at, event.at);
    totals[event.source]++;
    if (event.tokens !== null) {
      row.tokens += event.tokens;
      row.measured++;
      totals.tokens += event.tokens;
      totals.measured++;
    }
    rows.set(key, row);
  }
  return {
    start,
    totals,
    rows: [...rows.values()].sort((first, second) => second.at - first.at),
  };
}

export function usageReport(
  events: readonly UsageEvent[],
  period: UsagePeriod,
  now: number,
) {
  return summarize(events, startOfPeriod(period, now), now);
}

export function previousUsageTotals(
  events: readonly UsageEvent[],
  period: UsagePeriod,
  now: number,
) {
  if (period === USAGE_PERIOD.ALL) return null;
  const currentStart = startOfPeriod(period, now);
  const previousStart = startOfPeriod(period, currentStart - 1);
  const localNow = new Date(now);
  const localStart = new Date(currentStart);
  const calendarDay = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const elapsedDays =
    (calendarDay(localNow) - calendarDay(localStart)) / PREVIEW.dayMs;
  const cutoff = new Date(previousStart);
  cutoff.setDate(cutoff.getDate() + elapsedDays);
  cutoff.setHours(
    localNow.getHours(),
    localNow.getMinutes(),
    localNow.getSeconds(),
    localNow.getMilliseconds(),
  );
  return summarize(
    events,
    previousStart,
    Math.min(currentStart - 1, cutoff.getTime()),
  ).totals;
}

export function usageChange(current: number | null, previous: number | null) {
  if (current === null || previous === null) return null;
  if (current === previous) return 0;
  return previous > 0
    ? ((current - previous) / previous) * PREVIEW.percentScale
    : null;
}

export function measuredMetric(
  available: boolean,
  current: number | null,
  previous: number | null,
) {
  const value = available ? current : null;
  return { value, change: usageChange(value, previous) };
}
