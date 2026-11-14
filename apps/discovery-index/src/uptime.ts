// Owns public seller uptime: which five-minute slots each NodeId held a signed presence the index
// accepted, and GET /v1/uptime?node=<NodeId>, which reports the share of slots seen over the last day,
// week and month. A window starts no earlier than the NodeId was first seen, so a new seller is not
// counted down for time before it existed. Built only from records the index already verified.
import { INDEX_ERRORS, UPTIME } from './constants';
import { indexFail } from './errors';

export { UPTIME } from './constants';

const RETENTION_DAYS = UPTIME.windowDays.at(-1)!;

export interface UptimeRow {
  hour: number;
  // One bit per five-minute slot of the hour, lowest bit first.
  slots: number;
  firstAt: number;
  lastAt: number;
}

export interface UptimeStorage {
  // Marks the slot holding `now` for the NodeId.
  markSeen(nodeId: string, now: number): Promise<void>;
  // The NodeId's rows from `sinceHour` on, oldest first.
  seen(nodeId: string, sinceHour: number): Promise<UptimeRow[]>;
  // Drops rows older than the longest window.
  pruneUptime(now: number): Promise<void>;
}

export const slotOf = (now: number) => Math.floor(now / UPTIME.slotMs);
export const hourOf = (now: number) => Math.floor(now / UPTIME.hourMs);
export const slotBit = (now: number) =>
  1 << (slotOf(now) % UPTIME.slotsPerHour);
// The first hour kept: rows before it are pruned.
export const retainedHour = (now: number) =>
  hourOf(now - RETENTION_DAYS * UPTIME.dayMs);

// One write per NodeId and slot per app instance: sellers refresh their presence far more often
// than every five minutes, and the storage write is idempotent anyway. Old rows are pruned here, on
// its own throttle and separately from record pruning, so retention holds even when no new NodeId
// publishes and a failing uptime table never blocks admitting one.
export function uptimeRecorder(storage: UptimeStorage | undefined) {
  const written = new Map<string, number>();
  let prunedAt = -Infinity;
  return async (nodeId: string, now: number) => {
    if (!storage) return;
    if (now - prunedAt >= UPTIME.pruneIntervalMs) {
      prunedAt = now;
      await storage.pruneUptime(now).catch(() => undefined);
    }
    if (written.get(nodeId) === slotOf(now)) return;
    if (written.size >= UPTIME.maxRemembered) written.clear();
    await storage.markSeen(nodeId, now);
    written.set(nodeId, slotOf(now));
  };
}

const NODE = /^[0-9a-f]{64}$/;
// Exactly one `node` parameter, a lowercase hex NodeId; anything else is 400.
export function parseUptimeQuery(url: string) {
  const params = new URL(url).searchParams;
  const node = params.get('node');
  if ([...params.keys()].length !== 1 || node === null || !NODE.test(node))
    indexFail(INDEX_ERRORS.INVALID_QUERY);
  return node;
}

function bits(value: number) {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count++;
  return count;
}

// Slots seen and slots elapsed from `first` to now, counting the current slot.
function window(rows: readonly UptimeRow[], first: number, now: number) {
  const last = slotOf(now);
  let seen = 0;
  for (const row of rows) {
    const base = row.hour * UPTIME.slotsPerHour;
    for (let bit = 0; bit < UPTIME.slotsPerHour; bit++) {
      const slot = base + bit;
      if (slot >= first && slot <= last && row.slots & (1 << bit)) seen++;
    }
  }
  const slots = last - first + 1;
  return {
    seen,
    slots,
    ratio: Math.round((seen / slots) * UPTIME.ratioScale) / UPTIME.ratioScale,
  };
}

// The NodeId's uptime, or null when the index has not seen it within the retention window.
export async function uptimePage(
  storage: UptimeStorage,
  nodeId: string,
  now: number,
) {
  const rows = (await storage.seen(nodeId, retainedHour(now))).filter(
    (row) => row.firstAt <= now,
  );
  if (!rows.length) return null;
  const firstSeenAt = Math.min(...rows.map((row) => row.firstAt));
  const lastSeenAt = Math.max(...rows.map((row) => row.lastAt));
  return JSON.stringify({
    nodeId,
    firstSeenAt,
    lastSeenAt,
    slotMs: UPTIME.slotMs,
    windows: UPTIME.windowDays.map((days) => ({
      days,
      // A full window holds exactly `days` of slots; a younger seller's starts at its first sighting.
      ...window(
        rows,
        Math.max(slotOf(now - days * UPTIME.dayMs) + 1, slotOf(firstSeenAt)),
        now,
      ),
    })),
    generatedAt: now,
  });
}

// The in-memory adapter's uptime rows (storage.ts), with their pruning.
export function memoryUptime() {
  const nodes = new Map<string, Map<number, UptimeRow>>();
  return {
    async pruneUptime(now: number) {
      for (const [id, hours] of nodes) {
        for (const hour of hours.keys())
          if (hour < retainedHour(now)) hours.delete(hour);
        if (!hours.size) nodes.delete(id);
      }
    },
    async markSeen(nodeId: string, now: number) {
      const hours = nodes.get(nodeId) ?? new Map<number, UptimeRow>();
      nodes.set(nodeId, hours);
      const prior = hours.get(hourOf(now));
      hours.set(hourOf(now), {
        hour: hourOf(now),
        slots: (prior?.slots ?? 0) | slotBit(now),
        firstAt: prior?.firstAt ?? now,
        lastAt: Math.max(prior?.lastAt ?? now, now),
      });
    },
    async seen(nodeId: string, sinceHour: number) {
      return [...(nodes.get(nodeId)?.values() ?? [])]
        .filter((row) => row.hour >= sinceHour)
        .sort((left, right) => left.hour - right.hour);
    },
  };
}
