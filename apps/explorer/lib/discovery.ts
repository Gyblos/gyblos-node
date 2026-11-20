// Owns the explorer's view of the discovery index: models offered now, sellers online and their uptime,
// and the network status of every registered seller, checked at the boundary.
// The index is read in one place: the Worker's scheduled run (scheduled.ts) calls refreshDiscovery, which
// sends at most DISCOVERY.maxRequestsPerRun requests within DISCOVERY.runDeadlineMs and stores what it
// read in KV; every render shows the stored catalog (loadSnapshot), so the index's load does not grow
// with viewers.
// A catalog is one whole read of /models, /network and every model's seller pages. Each model's pages
// are read within one run: the index orders them by each seller's latest presence, so a cursor does not
// outlive a run, and a seller that publishes a new presence while its model's later pages are read can be
// missed by that read; a catalog with more models than fit in a run is carried on by the next runs, and it
// replaces the shown catalog only once whole, so the page never shows part of the index as all of it.
// Uptimes change slowly and are read in turns, with a share of each run kept for them.

import { DISCOVERY_URL } from './config';
import { DISCOVERY } from './constants';
import {
  listedSeller,
  uptime,
  type Listed,
  type Seller,
  type Uptime,
} from './discovery-shape';
import { fetchJson } from './fetch-json';
import { parseNetworkStatus, type NetworkStatus } from './network-status';
import { list, nullable, num, record, text } from './validate';

export type { OfferedModel, Seller, Uptime } from './discovery-shape';

export interface DiscoverySnapshot {
  generatedAt: number;
  sellers: Seller[];
  // Null when the index has not answered /network (an older index): only online sellers are known.
  network: NetworkStatus | null;
  // When the shown catalog's read began, once that is longer ago than DISCOVERY.staleAfterMs; else null.
  readAt: number | null;
  error: string | null;
}

// One whole read of the index's catalog, from when it began.
interface Catalog {
  readAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  sellers: Listed[];
}
// A catalog read under way: the models listed when it began, how many of them are read, and their
// sellers, by node.
interface Pending {
  startedAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  modelIds: string[];
  model: number;
  sellers: Record<string, Listed>;
}
// A seller's last uptime read: when it was tried, and the last uptime read (kept when a try fails).
interface UptimeRead {
  triedAt: number;
  uptime: Uptime | null;
}
// What a run stores in KV (DISCOVERY.storedKey).
export interface StoredDiscovery {
  catalog: Catalog | null;
  pending: Pending | null;
  uptimes: Record<string, UptimeRead | undefined>;
}
// The KV calls the explorer makes (a Workers KV namespace binding has them).
export interface DiscoveryKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
// What went wrong in a run, as fixed codes (never a source's own text): logged by the scheduled run.
export type RunProblem =
  | 'models'
  | 'network'
  | 'sellers'
  | 'seller-record'
  | 'uptime'
  | 'catalog-restarted';

export const unavailable = (error: string): DiscoverySnapshot => ({
  generatedAt: 0,
  sellers: [],
  network: null,
  readAt: null,
  error,
});

const readJson = (path: string) =>
  fetchJson(`${DISCOVERY_URL}${path}`, `discovery ${path}`);

// A run's requests: at most DISCOVERY.maxRequestsPerRun, none begun after DISCOVERY.runDeadlineMs.
class Run {
  used = 0;
  readonly problems = new Set<RunProblem>();
  private readonly deadline: number;
  constructor(private readonly now: () => number) {
    this.deadline = now() + DISCOVERY.runDeadlineMs;
  }
  get left() {
    return this.now() >= this.deadline
      ? 0
      : DISCOVERY.maxRequestsPerRun - this.used;
  }
  read(path: string) {
    this.used += 1;
    return readJson(path);
  }
}

// Begins a catalog read: /models, then /network (the last catalog's when it fails or is malformed).
// Throws when /models fails or is malformed.
async function begin(
  run: Run,
  now: number,
  lastNetwork: NetworkStatus | null,
): Promise<Pending> {
  const listed = record(await run.read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const network = await run
    .read('/network')
    .then(parseNetworkStatus)
    .catch(() => {
      run.problems.add('network');
      return lastNetwork;
    });
  return {
    startedAt: now,
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    network,
    modelIds,
    model: 0,
    sellers: {},
  };
}

// Every seller of one model, page by page, or null when fewer than `keep` requests are left before its
// last page (it is read again from its first page in a later run). A malformed seller entry is skipped;
// a page that fails or is malformed throws.
async function sellersOf(
  run: Run,
  modelId: string,
  keep: number,
): Promise<Listed[] | null> {
  const sellers: Listed[] = [];
  let cursor: string | null = null;
  do {
    if (run.left <= keep) return null;
    const query = new URLSearchParams({
      model: modelId,
      limit: String(DISCOVERY.sellersPerPage),
    });
    if (cursor) query.set('cursor', cursor);
    const page = record(await run.read(`/sellers?${query}`), 'sellers page');
    for (const entry of list(page.sellers, 'sellers'))
      try {
        sellers.push(listedSeller(entry));
      } catch {
        run.problems.add('seller-record');
      }
    cursor = nullable(page.next, (present) => text(present, 'next'));
  } while (cursor);
  return sellers;
}

// Reads the models of `pending` in order while more than `keep` requests are left; a model whose page
// fails ends the run's catalog reading and is read again in the next run.
async function carryOn(run: Run, pending: Pending, keep: number) {
  while (pending.model < pending.modelIds.length && run.left > keep) {
    let sellers: Listed[] | null;
    try {
      sellers = await sellersOf(
        run,
        pending.modelIds[pending.model] ?? '',
        keep,
      );
    } catch {
      run.problems.add('sellers');
      return;
    }
    if (!sellers) return;
    for (const seller of sellers) pending.sellers[seller.nodeId] ??= seller;
    pending.model += 1;
  }
}

// The shown catalog's sellers whose uptime is due: never tried first, then the least recently tried.
function dueUptimes(stored: StoredDiscovery, now: number) {
  const triedAt = (nodeId: string) => stored.uptimes[nodeId]?.triedAt ?? -1;
  return (stored.catalog?.sellers ?? [])
    .map((seller) => seller.nodeId)
    .filter(
      (nodeId) =>
        !stored.uptimes[nodeId] ||
        now - triedAt(nodeId) >= DISCOVERY.uptimeRefreshMs,
    )
    .sort((left, right) => triedAt(left) - triedAt(right));
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
// way, or when the one under way began DISCOVERY.restartAfterMs ago), replaces the shown catalog when the
// read is whole, then tries the uptimes most due. Never throws: `problems` says what went wrong.
export async function readIndex(
  previous: StoredDiscovery | null,
  now: () => number,
): Promise<{ stored: StoredDiscovery; problems: RunProblem[] }> {
  const stored: StoredDiscovery = previous ?? {
    catalog: null,
    pending: null,
    uptimes: {},
  };
  const run = new Run(now);
  const keep = Math.min(
    dueUptimes(stored, now()).length,
    DISCOVERY.uptimeReservedPerRun,
  );
  if (
    stored.pending &&
    now() - stored.pending.startedAt >= DISCOVERY.restartAfterMs
  ) {
    run.problems.add('catalog-restarted');
    stored.pending = null;
  }
  try {
    stored.pending ??= await begin(run, now(), stored.catalog?.network ?? null);
  } catch {
    run.problems.add('models');
  }
  if (stored.pending) {
    await carryOn(run, stored.pending, keep);
    if (stored.pending.model >= stored.pending.modelIds.length) {
      stored.catalog = {
        readAt: stored.pending.startedAt,
        generatedAt: stored.pending.generatedAt,
        network: stored.pending.network,
        sellers: Object.values(stored.pending.sellers),
      };
      stored.pending = null;
    }
  }

  const listed = new Set(
    stored.catalog?.sellers.map((seller) => seller.nodeId),
  );
  for (const nodeId of Object.keys(stored.uptimes))
    if (!listed.has(nodeId)) delete stored.uptimes[nodeId];
  await inTurns(
    dueUptimes(stored, now()).slice(0, run.left),
    DISCOVERY.uptimeConcurrency,
    async (nodeId) => {
      const last = stored.uptimes[nodeId]?.uptime ?? null;
      try {
        const fresh = uptime(
          await run.read(`/uptime?node=${encodeURIComponent(nodeId)}`),
        );
        stored.uptimes[nodeId] = { triedAt: now(), uptime: fresh };
      } catch {
        run.problems.add('uptime');
        stored.uptimes[nodeId] = { triedAt: now(), uptime: last };
      }
    },
  );
  return { stored, problems: [...run.problems] };
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
