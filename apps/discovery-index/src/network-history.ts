import {
  INDEX_ERRORS,
  INDEX_ROUTES,
  NETWORK_HISTORY,
  UPTIME,
} from './constants';
import { indexFail } from './errors';
import { hourOf, slotOf, type UptimeStorage } from './uptime';

const hoursPerDay = UPTIME.dayMs / UPTIME.hourMs;
const dayOf = (hour: number) => Math.floor(hour / hoursPerDay);
const isoDay = (day: number) =>
  new Date(day * UPTIME.dayMs).toISOString().split('T')[0]!;
const bitsSet = (slots: number) => {
  let count = 0;
  for (let bit = 0; bit < UPTIME.slotsPerHour; bit++)
    count += (slots >> bit) & 1;
  return count;
};

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

export async function networkHistoryPage(
  storage: UptimeStorage,
  days: number,
  now: number,
) {
  const today = Math.floor(now / UPTIME.dayMs);
  const firstDay = today - days + 1;
  const sinceHour = firstDay * hoursPerDay;
  const [online, alive] = await Promise.all([
    storage.onlineSlots(sinceHour),
    storage.aliveSlots(sinceHour),
  ]);
  const history = Array.from({ length: days }, (_, index) => ({
    day: firstDay + index,
    nodeSlots: 0,
    peak: 0,
    coveredSlots: 0,
  }));
  for (const row of online) {
    const entry = history[dayOf(row.hour) - firstDay];
    if (!entry || row.hour > hourOf(now)) continue;
    for (const count of row.counts) {
      entry.nodeSlots += count;
      entry.peak = Math.max(entry.peak, count);
    }
  }
  for (const row of alive) {
    const entry = history[dayOf(row.hour) - firstDay];
    if (entry && row.hour <= hourOf(now))
      entry.coveredSlots += bitsSet(row.slots);
  }
  const elapsedToday = slotOf(now) - today * NETWORK_HISTORY.slotsPerDay + 1;
  return JSON.stringify({
    days,
    slotMs: UPTIME.slotMs,
    history: history.map(({ day, nodeSlots, peak, coveredSlots }) => {
      const partial = day === today;
      const expectedSlots = partial
        ? elapsedToday
        : NETWORK_HISTORY.slotsPerDay;
      return {
        day: isoDay(day),
        averageOnline:
          Math.round((nodeSlots / expectedSlots) * UPTIME.ratioScale) /
          UPTIME.ratioScale,
        peak,
        nodeSlots,
        coveredSlots,
        expectedSlots,
        partial,
      };
    }),
    generatedAt: now,
  });
}
