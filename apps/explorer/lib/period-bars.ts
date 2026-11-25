import { DISPLAY, RANGE, UNITS } from './constants';
import { usdcDecimal } from './format';
import type { TokenPoint } from './overview-activity';
import type { RangeDays } from './range';

type Daily = TokenPoint & { paidOut: ReturnType<typeof usdcDecimal> | null };
export interface HalfHour {
  at: number;
  tokens: number;
  requests: number;
  paidOut: bigint;
}
export type PeriodBar = Daily & {
  band: string;
  tick: string;
  blockStart?: boolean;
  outside?: boolean;
};
const month = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekday = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const HOURS = 24;
const SIX_HOURS = 6;
const HALF_HOURS_PER_DAY = 48;
const WEEK_SLOTS = 8;
const timeLabel = (at: number) =>
  new Date(at)
    .toISOString()
    .slice(RANGE.dayPrecision + 1, DISPLAY.minutePrecision);

function calendar(points: Daily[]): PeriodBar[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return [];
  const start = new Date(first.day);
  const end = new Date(last.day);
  start.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const rows = new Map(points.map((point) => [point.day, point]));
  const result: PeriodBar[] = [];
  for (let at = start.getTime(); at <= end.getTime(); at += UNITS.msPerDay) {
    const day = new Date(at).toISOString().slice(0, RANGE.dayPrecision);
    const row = rows.get(day);
    result.push({
      day,
      tokens: null,
      requests: null,
      paidOut: null,
      ...row,
      band: month.format(at),
      tick: day.split('-')[2]!,
      outside: day < first.day || day > last.day,
    });
  }
  return result;
}

function slices(point: Daily, slots: number, samples: HalfHour[]): PeriodBar[] {
  const start = Date.parse(point.day);
  const width = UNITS.msPerDay / slots;
  const rows = samples.filter(
    ({ at }) => at >= start && at < start + UNITS.msPerDay,
  );
  const totals = Array.from({ length: slots }, () => ({
    tokens: 0,
    requests: 0,
    paidOut: 0n,
  }));
  for (const row of rows) {
    const slot = totals[Math.floor((row.at - start) / width)];
    if (slot) {
      slot.tokens += row.tokens;
      slot.requests += row.requests;
      slot.paidOut += row.paidOut;
    }
  }
  const tokensMatch =
    rows.reduce((sum, row) => sum + row.tokens, 0) === point.tokens;
  const requestsMatch =
    rows.reduce((sum, row) => sum + row.requests, 0) === point.requests;
  const payoutsMatch =
    usdcDecimal(rows.reduce((sum, row) => sum + row.paidOut, 0n)) ===
    point.paidOut;
  return totals.map((row, index) => {
    const at = start + index * width;
    const hour = timeLabel(at);
    return {
      day: point.day + ' ' + hour,
      band: weekday.format(at),
      tick: slots === WEEK_SLOTS ? hour.slice(0, 2) : hour,
      blockStart: ((index * HOURS) / slots) % SIX_HOURS === 0,
      tokens: tokensMatch && requestsMatch ? row.tokens : null,
      requests: requestsMatch ? row.requests : null,
      paidOut: payoutsMatch ? usdcDecimal(row.paidOut) : null,
    };
  });
}

export function periodBars(
  points: Daily[],
  range: RangeDays,
  samples: HalfHour[],
): PeriodBar[] {
  if (range !== 1 && range !== DISPLAY.weekWindow) return calendar(points);
  return points.flatMap((point) =>
    slices(point, range === 1 ? HALF_HOURS_PER_DAY : WEEK_SLOTS, samples),
  );
}
