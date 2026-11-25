import {
  INDEX_ERRORS,
  INDEX_ROUTES,
  NETWORK_DAY_STATES,
  NETWORK_HISTORY,
  UPTIME,
} from './constants';
import { indexFail } from './errors';
import {
  slotBits,
  slotOf,
  type NetworkDayRow,
  type NetworkHistoryStorage,
} from './uptime';

const dayOfTime = (now: number) => Math.floor(now / UPTIME.dayMs);
const isoDay = (day: number) =>
  new Date(day * UPTIME.dayMs).toISOString().split('T')[0]!;
const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);
const ratio = (part: number, whole: number) =>
  Math.round((part / whole) * UPTIME.ratioScale) / UPTIME.ratioScale;

export function parseNetworkHistoryQuery(url: string): number {
  const params = new URL(url).searchParams;
  const keys = [...params.keys()];
  if (!keys.length) return NETWORK_HISTORY.defaultDays;
  const days = NETWORK_HISTORY.dayOptions.find(
    (option) => String(option) === params.get('days'),
  );
  if (keys.length !== 1 || keys[0] !== 'days' || days === undefined)
    indexFail(INDEX_ERRORS.INVALID_QUERY);
  return days;
}

export const networkHistoryKey = (origin: string, days: number) =>
  `${origin}${INDEX_ROUTES.NETWORK_HISTORY}?days=${days}`;

export async function summarizeDay(
  storage: NetworkHistoryStorage,
  day: number,
): Promise<NetworkDayRow> {
  const sinceHour = day * NETWORK_HISTORY.hoursPerDay;
  const untilHour = sinceHour + NETWORK_HISTORY.hoursPerDay;
  const [online, alive] = await Promise.all([
    storage.onlineSlots(sinceHour, untilHour),
    storage.aliveSlots(sinceHour, untilHour),
  ]);
  const counts = online.flatMap((row) => row.counts);
  return {
    day,
    nodeSlots: sum(counts),
    peak: Math.max(0, ...counts),
    coveredSlots: sum(alive.flatMap((row) => slotBits(row.slots))),
  };
}

const lastSettledDay = (now: number) =>
  dayOfTime(now - NETWORK_HISTORY.heartbeatSlots * UPTIME.slotMs) - 1;

export async function rollupNetworkDays(
  storage: NetworkHistoryStorage,
  now: number,
) {
  const firstDay = dayOfTime(now) - NETWORK_HISTORY.maxDays + 1;
  const done = new Set(
    (await storage.networkDays(firstDay)).map((row) => row.day),
  );
  const missing: number[] = [];
  for (let day = lastSettledDay(now); day >= firstDay; day--)
    if (!done.has(day)) missing.push(day);
  const batch = missing.slice(0, NETWORK_HISTORY.rollupDaysPerRun);
  for (const day of batch)
    await storage.saveNetworkDay(await summarizeDay(storage, day));
  return batch.length;
}

function dayEntry(
  day: number,
  row: NetworkDayRow | undefined,
  state: (typeof NETWORK_DAY_STATES)[keyof typeof NETWORK_DAY_STATES],
  expectedSlots: number,
) {
  return {
    day: isoDay(day),
    state,
    averageOnline: row ? ratio(row.nodeSlots, expectedSlots) : null,
    peak: row?.peak ?? null,
    nodeSlots: row?.nodeSlots ?? null,
    coveredSlots: row?.coveredSlots ?? null,
    expectedSlots,
  };
}

export async function networkHistoryPage(
  storage: NetworkHistoryStorage,
  days: number,
  now: number,
) {
  const today = dayOfTime(now);
  const firstDay = today - days + 1;
  const [rolled, current] = await Promise.all([
    storage.networkDays(firstDay),
    summarizeDay(storage, today),
  ]);
  const byDay = new Map(rolled.map((row) => [row.day, row]));
  const history = Array.from({ length: days - 1 }, (_, index) => {
    const day = firstDay + index;
    const row = byDay.get(day);
    return dayEntry(
      day,
      row,
      row ? NETWORK_DAY_STATES.FINAL : NETWORK_DAY_STATES.PENDING,
      NETWORK_HISTORY.slotsPerDay,
    );
  });
  const elapsed = slotOf(now) - today * NETWORK_HISTORY.slotsPerDay + 1;
  history.push(dayEntry(today, current, NETWORK_DAY_STATES.PARTIAL, elapsed));
  return JSON.stringify({
    days,
    slotMs: UPTIME.slotMs,
    history,
    generatedAt: now,
  });
}
