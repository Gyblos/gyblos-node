// The `uptime` line of `gyblos seller status --online`: how often the discovery index accepted this seller's
// signed presence (five-minute slots over a day, a week and a month) and when it last did. Sends only
// the public NodeId; what the index reports is its view, not proof.
import { fetchUptime, type SellerUptime } from '@gyblos/discovery-http';

import { STATUS } from './constants';
import type { StatusSystem } from './status-system';

const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const PERCENT = 100;

function ago(ms: number) {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / SECOND))} s ago`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`;
  return `${Math.round(ms / HOUR)} h ago`;
}
const percent = (ratio: number) => `${(ratio * PERCENT).toFixed(1)}%`;
const label = (days: number) => (days === 1 ? '24h' : `${days} days`);

// What the sellers lookup found: listed (with the presence the index serves), absent, or not known.
export type IndexPresence =
  { listed: true; at: number } | { listed: false; absent: boolean };

function report(uptime: SellerUptime, now: number, presence: IndexPresence) {
  const windows = uptime.windows
    .map((window) => `${percent(window.ratio)} last ${label(window.days)}`)
    .join(', ');
  // Listed now: the presence the index serves is the latest signal. "Offline" only when the index
  // answered without this seller; an unreachable or cut-short lookup just shows the last slot seen.
  const last = presence.listed
    ? `online, last presence ${ago(now - presence.at)}`
    : uptime.lastSeenAt === null
      ? 'no presence in the last 30 days'
      : `${presence.absent ? 'offline since' : 'last presence'} ${iso(uptime.lastSeenAt)}`;
  return windows ? `${windows}; ${last}` : last;
}

export async function uptimeLine(
  system: Pick<StatusSystem, 'fetch' | 'now'>,
  baseUrl: string,
  nodeId: string,
  presence: IndexPresence,
) {
  try {
    const uptime = await fetchUptime({
      baseUrl,
      nodeId,
      fetch: system.fetch,
      timeoutMs: STATUS.indexTimeoutMs,
    });
    if (!uptime) return 'never seen by the index';
    return report(uptime, system.now(), presence);
  } catch {
    return 'unavailable (index unreachable)';
  }
}
