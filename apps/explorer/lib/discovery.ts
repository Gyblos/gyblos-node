// Owns the explorer's view of the discovery index: models offered now, sellers online and their uptime,
// and the network status of every registered seller, checked at the boundary.
// The index is read in one place: the Worker's scheduled run (worker.ts) calls refreshDiscovery, which
// reads within DISCOVERY.maxRequestsPerRun requests and stores the result in KV; every render turns that
// stored read into a snapshot (loadSnapshot), so the index's load does not grow with viewers. A run reads
// /models and /network, then the seller lists of the models least recently read, then the uptimes most
// in need of a read; what does not fit waits for the next run, and the snapshot says what is missing.

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
  // Null when the index does not answer /network (an older index): only online sellers are known.
  network: NetworkStatus | null;
  // Models listed by the index whose sellers have not been read yet: what they are offered at is unknown.
  unreadModels: string[];
  // Set when the last read is older than DISCOVERY.staleAfterMs (the index is not answering): when it ended.
  staleFrom: number | null;
  error: string | null;
}

type Listed = Omit<Seller, 'uptime'>;
// What a run stores in KV: the latest read of each part of the index, with when it was read.
export interface StoredDiscovery {
  readAt: number;
  generatedAt: number;
  modelIds: string[];
  network: NetworkStatus | null;
  lists: Record<string, { readAt: number; sellers: Listed[] } | undefined>;
  uptimes: Record<string, { readAt: number; uptime: Uptime } | undefined>;
}
// The KV calls the explorer makes (a Workers KV namespace binding has them).
export interface DiscoveryKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
// Versioned: after a deploy that changes StoredDiscovery, renders show nothing until the first run.
export const STORED_KEY = 'discovery/v1';

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

// Every seller of one model, page by page; null when the run's budget ends first (the model waits for
// the next run and keeps its last list).
async function sellersOf(
  budget: Budget,
  modelId: string,
): Promise<Listed[] | null> {
  const sellers: Listed[] = [];
  let cursor: string | null = null;
  for (let pages = 0; ; pages += 1) {
    if (pages === DISCOVERY.maxSellerPages)
      throw new Error(`discovery /sellers: more than ${pages} pages`);
    if (budget.left <= 0) return null;
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

// The sellers online now: every read list of a listed model, once per node; with a complete network
// status, only the nodes it calls online (a list read in an earlier run may hold one gone since).
function onlineSellers(stored: StoredDiscovery): Listed[] {
  const online =
    stored.network && !stored.network.truncated
      ? new Set(
          stored.network.nodes
            .filter((node) => node.state === 'online')
            .map((node) => node.nodeId),
        )
      : null;
  const byNode = new Map<string, Listed>();
  for (const modelId of stored.modelIds)
    for (const seller of stored.lists[modelId]?.sellers ?? [])
      if (!byNode.has(seller.nodeId) && (!online || online.has(seller.nodeId)))
        byNode.set(seller.nodeId, seller);
  return [...byNode.values()];
}

// Never-read keys first, then the least recently read.
const oldestFirst =
  (readAt: (key: string) => number | undefined) =>
  (left: string, right: string) =>
    (readAt(left) ?? -1) - (readAt(right) ?? -1);

// One run: reads what fits in the budget over the previous stored read and returns the new one. Throws
// when /models or a seller list fails or is malformed: nothing is stored, and the snapshot ages into old.
export async function readIndex(
  previous: StoredDiscovery | null,
  now: () => number,
): Promise<StoredDiscovery> {
  const budget = new Budget();
  const listed = record(await budget.read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const network = await budget
    .read('/network')
    .then(parseNetworkStatus, () => null);

  const lists: StoredDiscovery['lists'] = {};
  for (const modelId of modelIds) lists[modelId] = previous?.lists[modelId];
  for (const modelId of [...modelIds].sort(
    oldestFirst((key) => lists[key]?.readAt),
  )) {
    if (budget.left <= 0) break;
    const sellers = await sellersOf(budget, modelId);
    if (sellers) lists[modelId] = { readAt: now(), sellers };
  }

  const stored: StoredDiscovery = {
    readAt: 0,
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    modelIds,
    network,
    lists,
    uptimes: {},
  };
  const nodeIds = onlineSellers(stored).map((seller) => seller.nodeId);
  for (const nodeId of nodeIds)
    stored.uptimes[nodeId] = previous?.uptimes[nodeId];
  const due = nodeIds
    .filter((nodeId) => {
      const last = stored.uptimes[nodeId];
      return !last || now() - last.readAt >= DISCOVERY.uptimeRefreshMs;
    })
    .sort(oldestFirst((key) => stored.uptimes[key]?.readAt))
    .slice(0, Math.max(0, budget.left));
  await Promise.all(
    due.map(async (nodeId) => {
      try {
        const read = uptime(
          await budget.read(`/uptime?node=${encodeURIComponent(nodeId)}`),
        );
        stored.uptimes[nodeId] = { readAt: now(), uptime: read };
      } catch {
        // The last uptime read, if any, stays until a later run.
      }
    }),
  );
  stored.readAt = now();
  return stored;
}

function parseStored(raw: string | null): StoredDiscovery | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredDiscovery;
  } catch {
    return null;
  }
}

// The scheduled run: one read of the index over the stored one, stored back. Throws when the read fails.
export async function refreshDiscovery(kv: DiscoveryKv, now: () => number) {
  const previous = parseStored(await kv.get(STORED_KEY));
  await kv.put(STORED_KEY, JSON.stringify(await readIndex(previous, now)));
}

const unavailable = (error: string): DiscoverySnapshot => ({
  generatedAt: 0,
  sellers: [],
  network: null,
  unreadModels: [],
  staleFrom: null,
  error,
});

// What a render shows from a stored read.
export function snapshotOf(
  stored: StoredDiscovery | null,
  now: number,
): DiscoverySnapshot {
  if (!stored) return unavailable('discovery not read yet');
  return {
    generatedAt: stored.generatedAt,
    sellers: onlineSellers(stored).map((seller) => ({
      ...seller,
      uptime: stored.uptimes[seller.nodeId]?.uptime ?? null,
    })),
    network: stored.network,
    unreadModels: stored.modelIds.filter((modelId) => !stored.lists[modelId]),
    staleFrom:
      now - stored.readAt > DISCOVERY.staleAfterMs ? stored.readAt : null,
    error: null,
  };
}

// A Worker instance's last KV read, reused for DISCOVERY.reuseMs. Only the settled value is kept: a
// Worker cannot await another request's pending read.
let reused: { at: number; stored: StoredDiscovery | null } | null = null;

// A render's read: the stored snapshot, from this instance's last KV read when it is recent enough.
export async function loadSnapshot(
  kv: DiscoveryKv,
  now: number,
): Promise<DiscoverySnapshot> {
  if (!reused || now - reused.at >= DISCOVERY.reuseMs) {
    try {
      reused = { at: now, stored: parseStored(await kv.get(STORED_KEY)) };
    } catch (error) {
      return unavailable(
        error instanceof Error ? error.message : 'discovery unavailable',
      );
    }
  }
  return snapshotOf(reused.stored, now);
}
