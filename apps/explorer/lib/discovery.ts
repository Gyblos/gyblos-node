// Owns the explorer's view of the discovery index: models offered now, sellers online and their uptime,
// and the network status of every registered seller, checked at the boundary.
// The index is read in one place: the Worker's scheduled run (scheduled.ts) calls refreshDiscovery, which
// sends at most DISCOVERY.maxRequestsPerRun requests and stores the result in KV; every render turns that
// stored read into a snapshot (loadSnapshot), so the index's load does not grow with viewers. A run reads
// /models and /network, then the seller lists least recently read, then the uptimes most in need of a
// read (with a share of the run kept for them); what does not fit or fails keeps its last read and waits
// for the next run, and the snapshot says what is unknown rather than showing it as absent.

import { DISCOVERY_URL } from './config';
import { DISCOVERY } from './constants';
import { fetchJson } from './fetch-json';
import { parseNetworkStatus, type NetworkStatus } from './network-status';
import { list, nullable, num, record, text } from './validate';

export interface OfferedModel {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  pricing: { inputAtomicPerMtok: string; outputAtomicPerMtok: string };
}
export interface Uptime {
  firstSeenAt: number;
  windows: { days: number; ratio: number }[];
}
export interface Seller {
  nodeId: string;
  owner: string;
  models: OfferedModel[];
  uptime: Uptime | null;
}
export interface DiscoverySnapshot {
  generatedAt: number;
  sellers: Seller[];
  // Null without a recent network status (an older index, or /network not answering).
  network: NetworkStatus | null;
  // Models listed by the index whose sellers are unknown now: what they are offered at is unknown.
  unreadModels: string[];
  // Set when the last read is older than DISCOVERY.staleAfterMs: when it ended.
  staleFrom: number | null;
  error: string | null;
}

type Listed = Omit<Seller, 'uptime'>;
// What a run stores in KV: the latest read of each part of the index, with when it was read.
export interface StoredDiscovery {
  readAt: number;
  generatedAt: number;
  modelIds: string[];
  network: { readAt: number; status: NetworkStatus } | null;
  lists: Record<string, { readAt: number; sellers: Listed[] } | undefined>;
  uptimes: Record<string, { readAt: number; uptime: Uptime } | undefined>;
}
// The KV calls the explorer makes (a Workers KV namespace binding has them).
export interface DiscoveryKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
// Bump the version whenever StoredDiscovery changes: renders then show nothing until the next run.
export const STORED_KEY = 'discovery/v1';

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'discovery unavailable';
export const unavailable = (error: string): DiscoverySnapshot => ({
  generatedAt: 0,
  sellers: [],
  network: null,
  unreadModels: [],
  staleFrom: null,
  error,
});

const readJson = (path: string) =>
  fetchJson(`${DISCOVERY_URL}${path}`, `discovery ${path}`);

function offeredModel(value: unknown): OfferedModel {
  const source = record(value, 'model');
  const pricing = record(source.pricing, 'model.pricing');
  const optional = (field: unknown, where: string) =>
    nullable(field, (present) => text(present, where));
  return {
    modelId: text(source.modelId, 'model.modelId'),
    variant: optional(source.variant, 'model.variant'),
    quantization: optional(source.quantization, 'model.quantization'),
    contextTokens: num(source.contextTokens, 'model.contextTokens'),
    pricing: {
      inputAtomicPerMtok: text(pricing.inputAtomicPerMtok, 'pricing.input'),
      outputAtomicPerMtok: text(pricing.outputAtomicPerMtok, 'pricing.output'),
    },
  };
}
function uptime(value: unknown): Uptime {
  const source = record(value, 'uptime');
  return {
    firstSeenAt: num(source.firstSeenAt, 'uptime.firstSeenAt'),
    windows: list(source.windows, 'uptime.windows').map((entry) => {
      const window = record(entry, 'uptime.window');
      return {
        days: num(window.days, 'window.days'),
        ratio: num(window.ratio, 'window.ratio'),
      };
    }),
  };
}

// Counts a run's requests against DISCOVERY.maxRequestsPerRun.
class Budget {
  used = 0;
  get left() {
    return DISCOVERY.maxRequestsPerRun - this.used;
  }
  read(path: string) {
    this.used += 1;
    return readJson(path);
  }
}

// Every seller of one model, page by page; null when fewer than `keep` requests would be left for the
// next page (the model keeps its last list). Throws when a page fails or is malformed.
async function sellersOf(
  budget: Budget,
  modelId: string,
  keep: number,
): Promise<Listed[] | null> {
  const sellers: Listed[] = [];
  let cursor: string | null = null;
  for (;;) {
    if (budget.left <= keep) return null;
    const query = new URLSearchParams({
      model: modelId,
      limit: String(DISCOVERY.sellersPerPage),
    });
    if (cursor) query.set('cursor', cursor);
    const page = record(await budget.read(`/sellers?${query}`), 'sellers page');
    for (const entry of list(page.sellers, 'sellers')) {
      const catalog = record(record(entry, 'seller').catalog, 'catalog');
      const signed = record(catalog.record, 'catalog.record');
      sellers.push({
        nodeId: text(signed.nodeId, 'record.nodeId'),
        owner: text(signed.owner, 'record.owner'),
        models: list(signed.models, 'record.models').map(offeredModel),
      });
    }
    cursor = nullable(page.next, (present) => text(present, 'next'));
    if (!cursor) return sellers;
  }
}

const recent = (readAt: number, now: number) =>
  now - readAt <= DISCOVERY.staleAfterMs;

// The network status still recent at `now`, or null.
function recentNetwork(stored: StoredDiscovery, now: number) {
  return stored.network && recent(stored.network.readAt, now)
    ? stored.network.status
    : null;
}

// A model's sellers are known when its list was read and either the list is recent or a recent, complete
// network status tells which of its sellers are still online.
function listKnown(stored: StoredDiscovery, modelId: string, now: number) {
  const listed = stored.lists[modelId];
  if (!listed) return false;
  const network = recentNetwork(stored, now);
  return (network !== null && !network.truncated) || recent(listed.readAt, now);
}

// The sellers online now: the known lists of the listed models, once per node; with a recent, complete
// network status, only the nodes it calls online (a list read in an earlier run may hold one gone since).
function onlineSellers(stored: StoredDiscovery, now: number): Listed[] {
  const network = recentNetwork(stored, now);
  const online =
    network && !network.truncated
      ? new Set(
          network.nodes
            .filter((node) => node.state === 'online')
            .map((node) => node.nodeId),
        )
      : null;
  const byNode = new Map<string, Listed>();
  for (const modelId of stored.modelIds) {
    if (!listKnown(stored, modelId, now)) continue;
    for (const seller of stored.lists[modelId]?.sellers ?? [])
      if (!byNode.has(seller.nodeId) && (!online || online.has(seller.nodeId)))
        byNode.set(seller.nodeId, seller);
  }
  return [...byNode.values()];
}

// Never-read keys first, then the least recently read.
const oldestFirst =
  (readAt: (key: string) => number | undefined) =>
  (left: string, right: string) =>
    (readAt(left) ?? -1) - (readAt(right) ?? -1);

// The online sellers whose uptime is due, never read first, then the oldest.
function dueUptimes(stored: StoredDiscovery, now: number) {
  return onlineSellers(stored, now)
    .map((seller) => seller.nodeId)
    .filter((nodeId) => {
      const last = stored.uptimes[nodeId];
      return !last || now - last.readAt >= DISCOVERY.uptimeRefreshMs;
    })
    .sort(oldestFirst((key) => stored.uptimes[key]?.readAt));
}

// Runs `work` over `items`, at most `limit` at a time.
async function inTurns<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

// One run: reads what fits in the budget over the previous stored read and returns the new one. Throws
// only when /models fails or is malformed: nothing is stored, and the snapshot ages into old.
export async function readIndex(
  previous: StoredDiscovery | null,
  now: () => number,
): Promise<StoredDiscovery> {
  const budget = new Budget();
  const listed = record(await budget.read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const status = await budget
    .read('/network')
    .then(parseNetworkStatus)
    .catch(() => null);

  const stored: StoredDiscovery = {
    readAt: 0,
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    modelIds,
    network: status ? { readAt: now(), status } : (previous?.network ?? null),
    lists: {},
    uptimes: {},
  };
  for (const modelId of modelIds)
    stored.lists[modelId] = previous?.lists[modelId];
  for (const [nodeId, read] of Object.entries(previous?.uptimes ?? {}))
    stored.uptimes[nodeId] = read;

  const keep = Math.min(
    dueUptimes(stored, now()).length,
    DISCOVERY.uptimeReservedPerRun,
  );
  for (const modelId of [...modelIds].sort(
    oldestFirst((key) => stored.lists[key]?.readAt),
  )) {
    if (budget.left <= keep) break;
    try {
      const sellers = await sellersOf(budget, modelId, keep);
      if (sellers) stored.lists[modelId] = { readAt: now(), sellers };
    } catch {
      // The model keeps its last list, if any, until a later run.
    }
  }

  const online = new Set(
    onlineSellers(stored, now()).map((seller) => seller.nodeId),
  );
  for (const nodeId of Object.keys(stored.uptimes))
    if (!online.has(nodeId)) delete stored.uptimes[nodeId];
  await inTurns(
    dueUptimes(stored, now()).slice(0, budget.left),
    DISCOVERY.uptimeConcurrency,
    async (nodeId) => {
      try {
        const read = uptime(
          await budget.read(`/uptime?node=${encodeURIComponent(nodeId)}`),
        );
        stored.uptimes[nodeId] = { readAt: now(), uptime: read };
      } catch {
        // The last uptime read, if any, stays until a later run.
      }
    },
  );
  stored.readAt = now();
  return stored;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The stored read, or null when there is none or it is not the shape this version writes.
function parseStored(raw: string | null): StoredDiscovery | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) &&
      typeof value.readAt === 'number' &&
      typeof value.generatedAt === 'number' &&
      Array.isArray(value.modelIds) &&
      (value.network === null || isObject(value.network)) &&
      isObject(value.lists) &&
      isObject(value.uptimes)
      ? (value as unknown as StoredDiscovery)
      : null;
  } catch {
    return null;
  }
}

// The scheduled run: one read of the index over the stored one, stored back. Throws when the read fails.
export async function refreshDiscovery(kv: DiscoveryKv, now: () => number) {
  const previous = parseStored(await kv.get(STORED_KEY));
  await kv.put(STORED_KEY, JSON.stringify(await readIndex(previous, now)));
}

// What a render shows from a stored read.
export function snapshotOf(
  stored: StoredDiscovery | null,
  now: number,
): DiscoverySnapshot {
  if (!stored) return unavailable('discovery not read yet');
  return {
    generatedAt: stored.generatedAt,
    sellers: onlineSellers(stored, now).map((seller) => ({
      ...seller,
      uptime: stored.uptimes[seller.nodeId]?.uptime ?? null,
    })),
    network: recentNetwork(stored, now),
    unreadModels: stored.modelIds.filter(
      (modelId) => !listKnown(stored, modelId, now),
    ),
    staleFrom: recent(stored.readAt, now) ? null : stored.readAt,
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

// A render's read: the stored snapshot, from this instance's last KV read when it is recent enough; when
// KV fails, from that last read if there is one.
export async function loadSnapshot(
  kv: DiscoveryKv,
  now: number,
): Promise<DiscoverySnapshot> {
  const last = reused?.kv === kv ? reused : null;
  if (last && now >= last.at && now - last.at < DISCOVERY.reuseMs)
    return snapshotOf(last.stored, now);
  try {
    reused = { kv, at: now, stored: parseStored(await kv.get(STORED_KEY)) };
    return snapshotOf(reused.stored, now);
  } catch (error) {
    return last ? snapshotOf(last.stored, now) : unavailable(errorText(error));
  }
}
