// Owns the explorer's view of the discovery index: models offered now, sellers online and their uptime,
// and the network status of every registered seller, checked at the boundary.
// The index is read in one place: the Worker's scheduled run (scheduled.ts) calls refreshDiscovery, which
// sends at most DISCOVERY.maxRequestsPerRun requests and stores what it read in KV; every render shows the
// stored catalog (loadSnapshot), so the index's load does not grow with viewers.
// A catalog is one whole read of /models, /network and every model's seller pages: when it does not fit
// in one run, the next runs carry on where it stopped, and it replaces the shown catalog only once whole,
// so a page never mixes reads or shows part of the index as all of it. Uptimes change slowly and are read
// in turns, with a share of each run kept for them.

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
  // Null when the index did not answer /network (an older index): only online sellers are known.
  network: NetworkStatus | null;
  // When the shown catalog was read, once that is longer ago than DISCOVERY.staleAfterMs; null before.
  readAt: number | null;
  error: string | null;
}

type Listed = Omit<Seller, 'uptime'>;
// One whole read of the index's catalog.
interface Catalog {
  readAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  sellers: Listed[];
}
// A catalog read under way: the models listed when it began, the model and page it is at, and the
// sellers read so far, by node.
interface Pending {
  startedAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  modelIds: string[];
  model: number;
  cursor: string | null;
  sellers: Record<string, Listed>;
}
// What a run stores in KV.
export interface StoredDiscovery {
  catalog: Catalog | null;
  pending: Pending | null;
  uptimes: Record<string, { readAt: number; uptime: Uptime } | undefined>;
}
// The KV calls the explorer makes (a Workers KV namespace binding has them).
export interface DiscoveryKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
// Bump the version whenever StoredDiscovery changes: renders then show nothing until the next whole read.
export const STORED_KEY = 'discovery/v1';

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'discovery unavailable';
export const unavailable = (error: string): DiscoverySnapshot => ({
  generatedAt: 0,
  sellers: [],
  network: null,
  readAt: null,
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

// Begins a catalog read: /models, then /network (null when it fails or is malformed). Throws when
// /models fails or is malformed.
async function begin(budget: Budget, now: number): Promise<Pending> {
  const listed = record(await budget.read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const network = await budget
    .read('/network')
    .then(parseNetworkStatus)
    .catch(() => null);
  return {
    startedAt: now,
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    network,
    modelIds,
    model: 0,
    cursor: null,
    sellers: {},
  };
}

// Reads seller pages of `pending` in order while more than `keep` requests are left. A page that fails
// ends the run's reading, and a model whose later page fails is read again from its first page.
async function carryOn(budget: Budget, pending: Pending, keep: number) {
  while (pending.model < pending.modelIds.length && budget.left > keep) {
    const modelId = pending.modelIds[pending.model] ?? '';
    const query = new URLSearchParams({
      model: modelId,
      limit: String(DISCOVERY.sellersPerPage),
    });
    if (pending.cursor) query.set('cursor', pending.cursor);
    try {
      const page = record(
        await budget.read(`/sellers?${query}`),
        'sellers page',
      );
      for (const entry of list(page.sellers, 'sellers')) {
        const catalog = record(record(entry, 'seller').catalog, 'catalog');
        const signed = record(catalog.record, 'catalog.record');
        const nodeId = text(signed.nodeId, 'record.nodeId');
        pending.sellers[nodeId] ??= {
          nodeId,
          owner: text(signed.owner, 'record.owner'),
          models: list(signed.models, 'record.models').map(offeredModel),
        };
      }
      pending.cursor = nullable(page.next, (present) => text(present, 'next'));
      if (!pending.cursor) pending.model += 1;
    } catch {
      pending.cursor = null;
      return;
    }
  }
}

// The catalog's sellers whose uptime is due: never read first, then the oldest.
function dueUptimes(stored: StoredDiscovery, now: number) {
  const readAt = (nodeId: string) => stored.uptimes[nodeId]?.readAt ?? -1;
  return (stored.catalog?.sellers ?? [])
    .map((seller) => seller.nodeId)
    .filter(
      (nodeId) =>
        !stored.uptimes[nodeId] ||
        now - readAt(nodeId) >= DISCOVERY.uptimeRefreshMs,
    )
    .sort((left, right) => readAt(left) - readAt(right));
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

// One run over the previous stored read: carries the catalog read on (beginning one when none is under
// way, or when the one under way is older than DISCOVERY.restartAfterMs), replaces the catalog when the
// read is whole, then reads the uptimes most due. `error` says why no catalog read could begin.
export async function readIndex(
  previous: StoredDiscovery | null,
  now: () => number,
): Promise<{ stored: StoredDiscovery; error: string | null }> {
  const stored: StoredDiscovery = previous ?? {
    catalog: null,
    pending: null,
    uptimes: {},
  };
  const budget = new Budget();
  const keep = Math.min(
    dueUptimes(stored, now()).length,
    DISCOVERY.uptimeReservedPerRun,
  );
  let error: string | null = null;
  try {
    if (
      !stored.pending ||
      now() - stored.pending.startedAt >= DISCOVERY.restartAfterMs
    )
      stored.pending = await begin(budget, now());
    await carryOn(budget, stored.pending, keep);
    if (stored.pending.model >= stored.pending.modelIds.length) {
      stored.catalog = {
        readAt: now(),
        generatedAt: stored.pending.generatedAt,
        network: stored.pending.network,
        sellers: Object.values(stored.pending.sellers),
      };
      stored.pending = null;
    }
  } catch (failure) {
    error = errorText(failure);
  }

  const listed = new Set(
    stored.catalog?.sellers.map((seller) => seller.nodeId),
  );
  for (const nodeId of Object.keys(stored.uptimes))
    if (!listed.has(nodeId)) delete stored.uptimes[nodeId];
  await inTurns(
    dueUptimes(stored, now()).slice(0, budget.left),
    DISCOVERY.uptimeConcurrency,
    async (nodeId) => {
      try {
        const fresh = uptime(
          await budget.read(`/uptime?node=${encodeURIComponent(nodeId)}`),
        );
        stored.uptimes[nodeId] = { readAt: now(), uptime: fresh };
      } catch {
        // The last uptime read, if any, stays until a later run.
      }
    },
  );
  return { stored, error };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The stored read, or null when there is none or it is not the shape this version writes.
function parseStored(raw: string | null): StoredDiscovery | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || !isObject(value.uptimes)) return null;
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

// The scheduled run: one run over the stored read, stored back. Throws, after storing, when no catalog
// read could begin (the index is not answering /models).
export async function refreshDiscovery(kv: DiscoveryKv, now: () => number) {
  const { stored, error } = await readIndex(
    parseStored(await kv.get(STORED_KEY)),
    now,
  );
  await kv.put(STORED_KEY, JSON.stringify(stored));
  if (error) throw new Error(error);
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
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      uptime: stored.uptimes[seller.nodeId]?.uptime ?? null,
    })),
    network: catalog.network,
    readAt:
      now - catalog.readAt > DISCOVERY.staleAfterMs ? catalog.readAt : null,
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
    reused = { kv, at: now, stored: parseStored(await kv.get(STORED_KEY)) };
    return snapshotOf(reused.stored, now);
  } catch (error) {
    return last ? snapshotOf(last.stored, now) : unavailable(errorText(error));
  }
}
