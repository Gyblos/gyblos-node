import { DISCOVERY_URL } from './config';
import {
  COVERAGE_NOTES,
  COVERAGE_STATES,
  SELLERS_ONLINE,
  type CoverageState,
} from './constants';
import { fetchBoundedJson } from './fetch-json';
import {
  list,
  nullable,
  num,
  record,
  SourceShapeError,
  text,
} from './validate';

const HISTORY_STATES: readonly CoverageState[] = [
  COVERAGE_STATES.FINAL,
  COVERAGE_STATES.PARTIAL,
  COVERAGE_STATES.PENDING,
];

export interface SellersOnlineDay {
  day: string;
  state: CoverageState;
  averageOnline: number | null;
  peak: number | null;
  coveredSlots: number | null;
  expectedSlots: number;
}
export interface SellersOnlineHistory {
  days: SellersOnlineDay[];
  error: boolean;
}
export interface SellersOnlinePoint {
  day: string;
  tick: string;
  value: number | null;
  amount: number | null;
  detail: string;
}

function parseDay(raw: unknown): SellersOnlineDay {
  const source = record(raw, 'network day');
  const day = text(source.day, 'network day.day');
  const state = HISTORY_STATES.find((option) => option === source.state);
  if (!SELLERS_ONLINE.isoDay.test(day) || !state)
    throw new SourceShapeError('network day');
  const count = (field: string) =>
    nullable(source[field], (value) => num(value, `network day.${field}`));
  return {
    day,
    state,
    averageOnline: count('averageOnline'),
    peak: count('peak'),
    coveredSlots: count('coveredSlots'),
    expectedSlots: num(source.expectedSlots, 'network day.expectedSlots'),
  };
}

export async function getSellersOnlineHistory(): Promise<SellersOnlineHistory> {
  try {
    const url = `${DISCOVERY_URL}${SELLERS_ONLINE.path}?days=${SELLERS_ONLINE.fetchDays}`;
    const source = record(
      await fetchBoundedJson(url, 'network history'),
      'network history',
    );
    if (source.days !== SELLERS_ONLINE.fetchDays)
      throw new SourceShapeError('network history days');
    return {
      days: list(source.history, 'network history.history').map(parseDay),
      error: false,
    };
  } catch {
    return { days: [], error: true };
  }
}

const UNWATCHED = 'no index heartbeat';

function observed(day: SellersOnlineDay) {
  return day.averageOnline === 0 && day.coveredSlots === 0
    ? null
    : day.averageOnline;
}

function watched(day: SellersOnlineDay) {
  return day.coveredSlots
    ? `${day.coveredSlots} of ${day.expectedSlots} slots watched`
    : UNWATCHED;
}

function detail(day: SellersOnlineDay) {
  if (day.averageOnline === null)
    return COVERAGE_NOTES[day.state] ?? COVERAGE_STATES.PENDING;
  if (observed(day) === null) return UNWATCHED;
  const parts = [`peak ${day.peak ?? 0}`, watched(day)];
  const note = COVERAGE_NOTES[day.state];
  return (note ? [note, ...parts] : parts).join(' · ');
}

export function sellersOnlinePoints(
  days: readonly SellersOnlineDay[],
  window = days.length,
): SellersOnlinePoint[] {
  return days.slice(-window).map((day) => ({
    day: day.day,
    tick: day.day.slice(SELLERS_ONLINE.dayOfMonth),
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
