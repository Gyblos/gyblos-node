// Owns the discovery read's KV side: the scheduled run stores each run's read (refreshDiscovery), and a
// render turns the stored read into what the page shows (loadSnapshot, snapshotOf).
import { DISCOVERY } from './constants';
import {
  readIndex,
  unavailable,
  type DiscoverySnapshot,
  type RunProblem,
  type StoredDiscovery,
} from './discovery';
import type { Uptime } from './discovery-shape';
import { listedOnline, normalizeNetwork } from './network-status';

// The KV calls the explorer makes (a Workers KV namespace binding has them).
export interface DiscoveryKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The stored read, or null when there is none or its outline is not what this version writes. Only the
// outline is checked: the value is the explorer's own, and DISCOVERY.storedKey's version changes with
// its shape.
function parseStored(raw: string | null): StoredDiscovery | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isObject(value) ||
      typeof value.progressAt !== 'number' ||
      !isObject(value.uptimes)
    )
      return null;
    const { catalog, pending } = value;
    const catalogFits =
      catalog === null ||
      (isObject(catalog) &&
        typeof catalog.readAt === 'number' &&
        Array.isArray(catalog.sellers));
    const pendingFits =
      pending === null ||
      (isObject(pending) &&
        typeof pending.startedAt === 'number' &&
        Array.isArray(pending.modelIds) &&
        typeof pending.model === 'number' &&
        isObject(pending.sellers));
    return catalogFits && pendingFits
      ? (value as unknown as StoredDiscovery)
      : null;
  } catch {
    return null;
  }
}

// The scheduled run: one run over the stored read, stored back. Returns what went wrong.
export async function refreshDiscovery(
  kv: DiscoveryKv,
  now: () => number,
): Promise<RunProblem[]> {
  const { stored, problems } = await readIndex(
    parseStored(await kv.get(DISCOVERY.storedKey)),
    now,
  );
  await kv.put(DISCOVERY.storedKey, JSON.stringify(stored));
  return problems;
}

// A seller's last uptime read while it is at most DISCOVERY.uptimeMaxAgeMs old (its tries since failed).
function shownUptime(
  read: StoredDiscovery['uptimes'][string],
  now: number,
): Uptime | null {
  return read?.uptime &&
    read.readAt !== null &&
    now - read.readAt <= DISCOVERY.uptimeMaxAgeMs
    ? { ...read.uptime, readAt: read.readAt }
    : null;
}

// What a render shows from a stored read: its catalog, with each seller's last uptime read.
export function snapshotOf(
  stored: StoredDiscovery | null,
  now: number,
): DiscoverySnapshot {
  const catalog = stored?.catalog;
  if (!stored || !catalog) return unavailable('discovery not read yet');
  return {
    generatedAt: catalog.generatedAt,
    models: catalog.models ?? {},
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      uptime: shownUptime(stored.uptimes[seller.nodeId], now),
    })),
    network: listedOnline(
      normalizeNetwork(catalog.network),
      catalog.sellers.map((seller) => seller.nodeId),
    ),
    datedAt:
      now - stored.progressAt > DISCOVERY.staleAfterMs ||
      now - catalog.readAt > DISCOVERY.restartAfterMs
        ? catalog.readAt
        : null,
    networkDatedAt:
      catalog.network &&
      catalog.networkReadAt !== null &&
      catalog.networkReadAt < catalog.readAt
        ? catalog.networkReadAt
        : null,
    error: null,
  };
}

// A Worker instance's last read of a KV namespace, reused for DISCOVERY.reuseMs. Only the settled value is
// kept: a Worker cannot await another request's pending read.
let reused: {
  kv: DiscoveryKv;
  at: number;
  stored: StoredDiscovery | null;
} | null = null;

// A render's read: the stored catalog, from this instance's last KV read when it is recent enough; when
// KV fails, from that last read if there is one.
export async function loadSnapshot(
  kv: DiscoveryKv,
  now: number,
): Promise<DiscoverySnapshot> {
  const last = reused?.kv === kv ? reused : null;
  if (last && now >= last.at && now - last.at < DISCOVERY.reuseMs)
    return snapshotOf(last.stored, now);
  try {
    reused = {
      kv,
      at: now,
      stored: parseStored(await kv.get(DISCOVERY.storedKey)),
    };
    return snapshotOf(reused.stored, now);
  } catch {
    return last ? snapshotOf(last.stored, now) : unavailable('KV unavailable');
  }
}
