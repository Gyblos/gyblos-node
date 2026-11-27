import {
  COVERAGE_NOTES,
  COVERAGE_STATES,
  SELLERS_ONLINE,
  type CoverageState,
} from './constants';

export interface SellersOnlineDay {
  day: string;
  state: CoverageState;
  averageOnline: number | null;
  peak: number | null;
  coveredSlots: number | null;
  expectedSlots: number;
}
export interface SellersOnlinePoint {
  day: string;
  tick: string;
  value: number | null;
  amount: number | null;
  detail: string;
}

const UNWATCHED = 'no index heartbeat';

function observed(day: SellersOnlineDay) {
  return day.averageOnline === 0 && day.coveredSlots === 0
    ? null
    : day.averageOnline;
}

function detail(day: SellersOnlineDay) {
  const note = COVERAGE_NOTES[day.state];
  if (day.averageOnline === null) return note ?? COVERAGE_STATES.PENDING;
  if (observed(day) === null)
    return note ? `${note} · ${UNWATCHED}` : UNWATCHED;
  const watched = day.coveredSlots
    ? `${day.coveredSlots} of ${day.expectedSlots} slots watched`
    : UNWATCHED;
  const parts = [`peak ${day.peak}`, watched];
  return (note ? [note, ...parts] : parts).join(' · ');
}

export function sellersOnlinePoints(
  days: readonly SellersOnlineDay[],
): SellersOnlinePoint[] {
  return days.map((day) => ({
    day: day.day,
    tick: day.day.slice(SELLERS_ONLINE.dayOfMonthStart),
    value: observed(day),
    amount: observed(day),
    detail: detail(day),
  }));
}

export function sellersOnlineSummary(days: readonly SellersOnlineDay[]) {
  const full = days.flatMap((day) => {
    const value = observed(day);
    return day.state === COVERAGE_STATES.FINAL && value !== null ? [value] : [];
  });
  const average = full.length
    ? Math.round(
        (full.reduce((sum, value) => sum + value, 0) / full.length) *
          SELLERS_ONLINE.averageScale,
      ) / SELLERS_ONLINE.averageScale
    : null;
  return { average, fullDays: full.length };
}
