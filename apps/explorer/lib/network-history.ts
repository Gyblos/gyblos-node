import { DISCOVERY_URL } from './config';
import {
  COVERAGE_STATES,
  SELLERS_ONLINE,
  type CoverageState,
} from './constants';
import { fetchBoundedJson } from './fetch-json';
import type { SellersOnlineDay } from './sellers-online';
import { list, record, SourceShapeError, text } from './validate';

const HISTORY = 'network history';
const HISTORY_STATES: readonly CoverageState[] = [
  COVERAGE_STATES.FINAL,
  COVERAGE_STATES.PARTIAL,
  COVERAGE_STATES.PENDING,
];
const METRICS = ['averageOnline', 'peak', 'coveredSlots'] as const;

export interface SellersOnlineHistory {
  days: SellersOnlineDay[];
  error: boolean;
}

function count(value: unknown, where: string, integer = true) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new SourceShapeError(where);
  return value;
}

function parseDay(raw: unknown): SellersOnlineDay {
  const source = record(raw, 'network day');
  const day = text(source.day, 'network day.day');
  const state = HISTORY_STATES.find((option) => option === source.state);
  if (!SELLERS_ONLINE.isoDay.test(day) || !state)
    throw new SourceShapeError('network day');
  const pending = state === COVERAGE_STATES.PENDING;
  const [averageOnline, peak, coveredSlots] = METRICS.map((field) => {
    if (pending && source[field] === null) return null;
    if (pending) throw new SourceShapeError(`network day.${field}`);
    return count(
      source[field],
      `network day.${field}`,
      field !== 'averageOnline',
    );
  });
  const expectedSlots = count(
    source.expectedSlots,
    'network day.expectedSlots',
  );
  if (!expectedSlots) throw new SourceShapeError('network day.expectedSlots');
  return {
    day,
    state,
    averageOnline: averageOnline ?? null,
    peak: peak ?? null,
    coveredSlots: coveredSlots ?? null,
    expectedSlots,
  };
}

function checkOrder(days: readonly SellersOnlineDay[]) {
  if (days.length > SELLERS_ONLINE.fetchDays)
    throw new SourceShapeError(`${HISTORY} length`);
  days.forEach((day, index) => {
    const previous = days[index - 1];
    if (
      (previous && previous.day >= day.day) ||
      (day.state === COVERAGE_STATES.PARTIAL && index !== days.length - 1)
    )
      throw new SourceShapeError(`${HISTORY} order`);
  });
}

export async function getSellersOnlineHistory(): Promise<SellersOnlineHistory> {
  try {
    const url = `${DISCOVERY_URL}${SELLERS_ONLINE.path}?days=${SELLERS_ONLINE.fetchDays}`;
    const source = record(await fetchBoundedJson(url, HISTORY), HISTORY);
    if (source.days !== SELLERS_ONLINE.fetchDays)
      throw new SourceShapeError(`${HISTORY} days`);
    const days = list(source.history, `${HISTORY}.history`).map(parseDay);
    checkOrder(days);
    return { days, error: false };
  } catch {
    return { days: [], error: true };
  }
}
