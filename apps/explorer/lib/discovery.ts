// Owns the explorer's view of the discovery index: models offered now, sellers online and their uptime,
// and the network status of every registered seller, checked at the boundary.
// The index is read in one place: the Worker's scheduled run reads it (readIndex) with at most
// DISCOVERY.maxRequestsPerRun requests within DISCOVERY.runDeadlineMs, into KV that every render reads
// (discovery-snapshot.ts), so the index's load does not grow with viewers.
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

export type { OfferedModel, Seller } from './discovery-shape';

export interface DiscoverySnapshot {
  generatedAt: number;
  sellers: Seller[];
  // Null when no network status has been read (/network failing, or absent from an older index): only
  // online sellers are known.
  network: NetworkStatus | null;
  // When the shown catalog's read began, once the index's catalog has not been read further for
  // DISCOVERY.staleAfterMs (it is not answering) or that read began over DISCOVERY.restartAfterMs ago;
  // else null.
  datedAt: number | null;
  // When the shown network status was read, when it is older than the shown catalog (/network failed
  // since); else null.
  networkDatedAt: number | null;
  error: string | null;
}

// One whole read of the index's catalog, from when it began (readAt), with when its network status was
// read (networkReadAt: earlier when /network failed during the read).
interface Catalog {
  readAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  networkReadAt: number | null;
  sellers: Listed[];
}
// A catalog read under way: the models listed when it began, how many of them are read, and their
// sellers, by node.
interface Pending {
  startedAt: number;
  generatedAt: number;
  network: NetworkStatus | null;
  networkReadAt: number | null;
  modelIds: string[];
  model: number;
  sellers: Record<string, Listed>;
}
// A seller's uptime: when it was last tried, and the last uptime read with when (kept when a try fails).
interface UptimeRead {
  triedAt: number;
  readAt: number | null;
  uptime: Uptime | null;
}
// What a run stores in KV (DISCOVERY.storedKey, discovery-snapshot.ts).
export interface StoredDiscovery {
  // The last run that read part of a catalog: older than DISCOVERY.staleAfterMs, the shown one is dated.
  progressAt: number;
  catalog: Catalog | null;
  pending: Pending | null;
  uptimes: Record<string, UptimeRead | undefined>;
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
  datedAt: null,
  networkDatedAt: null,
  error,
});

const readJson = (path: string) =>
  fetchJson(`${DISCOVERY_URL}${path}`, `discovery ${path}`);

// A run's requests: at most DISCOVERY.maxRequestsPerRun, none begun after DISCOVERY.runDeadlineMs.
class Run {
  private used = 0;
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

// Begins a catalog read: /models, then /network (the last catalog's when it fails, is malformed, or the
// run has ended).
// Throws when /models fails or is malformed.
async function begin(
  run: Run,
  now: number,
  last: Catalog | null,
): Promise<Pending> {
  const listed = record(await run.read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const network =
    run.left > 0
      ? await run
          .read('/network')
          .then(parseNetworkStatus)
          .catch(() => {
            run.problems.add('network');
            return null;
          })
      : null;
  return {
    startedAt: now,
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    network: network ?? last?.network ?? null,
    networkReadAt: network ? now : (last?.networkReadAt ?? null),
    modelIds,
    model: 0,
    sellers: {},
  };
}

// Every seller of one model, page by page, or null when the run ends before its last page (it is read
// again from its first page in a later run). A malformed seller entry is skipped; a page that fails or
// is malformed throws.
async function sellersOf(run: Run, modelId: string): Promise<Listed[] | null> {
  const sellers: Listed[] = [];
  let cursor: string | null = null;
  do {
    if (run.left <= 0) return null;
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

// Reads the models of `pending` in order while the run lasts; a model whose page fails ends the run's
// catalog reading and is read again in the next run. Returns whether a model was read.
async function carryOn(run: Run, pending: Pending) {
  const from = pending.model;
  while (pending.model < pending.modelIds.length && run.left > 0) {
    let sellers: Listed[] | null;
    try {
      const modelId = pending.modelIds[pending.model];
      if (modelId === undefined) break;
      sellers = await sellersOf(run, modelId);
    } catch {
      run.problems.add('sellers');
      break;
    }
    if (!sellers) break;
    for (const seller of sellers) pending.sellers[seller.nodeId] ??= seller;
    pending.model += 1;
  }
  return pending.model > from;
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
async function withConcurrency<T>(
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

// Tries the uptimes of `nodeIds` within the run, none begun at or after `until`,
// DISCOVERY.uptimeConcurrency at a time; a failed try keeps the last uptime and waits its turn like a
// read one.
async function tryUptimes(
  run: Run,
  stored: StoredDiscovery,
  nodeIds: string[],
  now: () => number,
  until = Infinity,
) {
  await withConcurrency(
    nodeIds.slice(0, run.left),
    DISCOVERY.uptimeConcurrency,
    async (nodeId) => {
      if (run.left <= 0 || now() >= until) return;
      const last = stored.uptimes[nodeId];
      try {
        const fresh = uptime(
          await run.read(`/uptime?node=${encodeURIComponent(nodeId)}`),
        );
        stored.uptimes[nodeId] = {
          triedAt: now(),
          readAt: now(),
          uptime: fresh,
        };
      } catch {
        run.problems.add('uptime');
        stored.uptimes[nodeId] = {
          triedAt: now(),
          readAt: last?.readAt ?? null,
          uptime: last?.uptime ?? null,
        };
      }
    },
  );
}

// One run over the previous stored read: first the uptimes most due, up to
// DISCOVERY.uptimeReservedPerRun and within DISCOVERY.reservedUptimesMs; then the catalog read (begun
// when none is under way, or again when the one under way began DISCOVERY.restartAfterMs ago), replacing
// the shown catalog once whole; then more due uptimes with what is left. Progress dates the shown
// catalog as current (progressAt) only while the read under way began less than
// DISCOVERY.restartAfterMs after it: a later one follows a read that never ended. Never throws:
// `problems` says what went wrong.
export async function readIndex(
  previous: StoredDiscovery | null,
  now: () => number,
): Promise<{ stored: StoredDiscovery; problems: RunProblem[] }> {
  const stored: StoredDiscovery = previous ?? {
    progressAt: now(),
    catalog: null,
    pending: null,
    uptimes: {},
  };
  const run = new Run(now);
  await tryUptimes(
    run,
    stored,
    dueUptimes(stored, now()).slice(0, DISCOVERY.uptimeReservedPerRun),
    now,
    now() + DISCOVERY.reservedUptimesMs,
  );

  if (
    stored.pending &&
    now() - stored.pending.startedAt >= DISCOVERY.restartAfterMs
  ) {
    run.problems.add('catalog-restarted');
    stored.pending = null;
  }
  try {
    if (!stored.pending && run.left > 0)
      stored.pending = await begin(run, now(), stored.catalog);
  } catch {
    run.problems.add('models');
  }
  const current =
    !stored.catalog ||
    (stored.pending?.startedAt ?? 0) - stored.catalog.readAt <
      DISCOVERY.restartAfterMs;
  if (stored.pending && (await carryOn(run, stored.pending)) && current)
    stored.progressAt = now();
  if (
    stored.pending &&
    stored.pending.model >= stored.pending.modelIds.length
  ) {
    const { startedAt, generatedAt, network, networkReadAt, sellers } =
      stored.pending;
    stored.catalog = {
      readAt: startedAt,
      generatedAt,
      network,
      networkReadAt,
      sellers: Object.values(sellers),
    };
    stored.pending = null;
    stored.progressAt = now();
  }

  const listed = new Set(
    stored.catalog?.sellers.map((seller) => seller.nodeId),
  );
  for (const nodeId of Object.keys(stored.uptimes))
    if (!listed.has(nodeId)) delete stored.uptimes[nodeId];
  await tryUptimes(run, stored, dueUptimes(stored, now()), now);
  return { stored, problems: [...run.problems] };
}
