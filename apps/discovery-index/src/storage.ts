// Owns the discovery index storage contract and its in-process adapter for tests and local runs.
// Entries hold only signed public data; callers never pass IPs, headers or request metadata.
import {
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
  type PublicRecordKind,
} from '@gyblos/protocol/constants';

import { INDEX_ERRORS, NODE_PUBLISH_QUOTA } from './constants';
import { indexFail } from './errors';
import { memoryUptime, type UptimeStorage } from './uptime';

// The NodeId's current catalog; `json` is its signed envelope exactly as published.
export interface StoredCatalog {
  sequence: number;
  expiresAt: number;
  withdrawn: boolean;
  json: string;
}

export interface NodeState {
  // High-water sequence shared by all three record kinds.
  lastSequence: number;
  catalog: StoredCatalog | null;
}

export interface StoredEntry {
  // Admission is checked with the write, never against an earlier storage snapshot.
  admission: { now: number; maxNodes: number; maxPublications: number };
  kind: PublicRecordKind;
  nodeId: string;
  owner: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  // Catalog digest: its own for a catalog, the referenced one for presence and withdrawal.
  digest: string;
  // Distinct model ids of a catalog; empty for other kinds.
  models: string[];
  signature: string;
  version?: string | null;
  retainUntil: number;
  json: string;
}

// The last NodeId of the previous page.
export interface SellerCursor {
  nodeId: string;
}

export interface SellerRow {
  nodeId: string;
  catalogJson: string;
  presenceJson: string;
}

export interface SellerQuery {
  model: string;
  now: number;
  limit: number;
  after: SellerCursor | null;
}

// A model listed by live, non-withdrawn catalogs with a live presence, and how many sellers list it.
export interface ModelRow {
  modelId: string;
  sellers: number;
}

// A NodeId's stored catalog: whether a live presence references it now (and its models then), and
// whether it was withdrawn. Read by GET /v1/network.
export interface CatalogStatusRow {
  nodeId: string;
  online: boolean;
  withdrawn: boolean;
  // The catalog's model ids while online; empty otherwise.
  models: string[];
}

export interface DiscoveryStorage extends UptimeStorage {
  activeVersions(
    now: number,
    limit: number,
    nodeId?: string,
  ): Promise<{ nodeId: string; version: string | null }[]>;
  state(nodeId: string): Promise<NodeState | null>;
  // Drops expired records; keeps high-water marks until their retainUntil. Uptime prunes itself.
  prune(now: number): Promise<void>;
  // Atomic: true when applied, false when the sequence is not above the high-water mark.
  put(entry: StoredEntry): Promise<boolean>;
  // Live, non-withdrawn catalogs listing `model` with a live presence that references them,
  // ordered by NodeId ascending: a seller keeps its place while it republishes its presence, so paging
  // never skips one that stays listed.
  list(query: SellerQuery): Promise<SellerRow[]>;
  // Every model those catalogs list, most sellers first, then model ID ascending; at most `limit`.
  models(now: number, limit: number): Promise<ModelRow[]>;
  // Unexpired stored records of all three kinds.
  count(now: number): Promise<number>;
  // Stored catalogs' status by NodeId, at most `limit` NodeIds and `maxModels` model rows (by NodeId,
  // then model id); `complete` is false when either cap cut the answer.
  catalogStatus(
    now: number,
    limit: number,
    maxModels: number,
  ): Promise<{ rows: CatalogStatusRow[]; complete: boolean }>;
}

interface MemoryNode {
  lastSequence: number;
  retainUntil: number;
  publishWindow: number;
  publishCount: number;
}

interface MemoryRecord {
  version?: string | null;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  digest: string;
  models: string[];
  json: string;
}

const compareRows = (left: SellerRow, right: SellerRow) =>
  left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;

// Listed as soon as accepted: a record issued slightly ahead of this clock is live, expiry is exact.
const live = (row: MemoryRecord, now: number) =>
  row.issuedAt <= now + CONTROL_LIMITS.clockSkewMs && row.expiresAt > now;

function dropExpired(table: Map<string, MemoryRecord>, now: number) {
  for (const [id, row] of table) if (row.expiresAt <= now) table.delete(id);
}

function countLive(table: Map<string, MemoryRecord>, now: number) {
  let total = 0;
  for (const row of table.values()) if (row.expiresAt > now) total++;
  return total;
}

interface MemoryTables {
  catalogs: Map<string, MemoryRecord>;
  presence: Map<string, MemoryRecord>;
  withdrawn: (nodeId: string, digest: string) => boolean;
}

function activePresence(
  tables: MemoryTables,
  nodeId: string,
  catalog: MemoryRecord,
  now: number,
) {
  const alive = tables.presence.get(nodeId);
  return alive &&
    alive.digest === catalog.digest &&
    !tables.withdrawn(nodeId, catalog.digest) &&
    live(alive, now) &&
    live(catalog, now)
    ? alive
    : undefined;
}
function versionsMemory(
  tables: MemoryTables,
  now: number,
  limit: number,
  selected?: string,
) {
  const rows = [];
  for (const nodeId of selected
    ? [selected]
    : [...tables.presence.keys()].sort()) {
    const catalog = tables.catalogs.get(nodeId);
    const alive = catalog && activePresence(tables, nodeId, catalog, now);
    if (alive) rows.push({ nodeId, version: alive.version ?? null });
    if (rows.length === limit) break;
  }
  return rows;
}
function modelsMemory(
  tables: MemoryTables,
  now: number,
  limit: number,
): ModelRow[] {
  const counts = new Map<string, number>();
  for (const [nodeId, catalog] of tables.catalogs) {
    if (!activePresence(tables, nodeId, catalog, now)) continue;
    for (const model of new Set(catalog.models))
      counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts]
    .map(([modelId, sellers]) => ({ modelId, sellers }))
    .sort((left, right) =>
      left.sellers !== right.sellers
        ? right.sellers - left.sellers
        : left.modelId < right.modelId
          ? -1
          : 1,
    )
    .slice(0, limit);
}

function catalogStatusMemory(
  tables: MemoryTables,
  now: number,
  limit: number,
  maxModels: number,
) {
  const ids = [...tables.catalogs.keys()].sort();
  let models = maxModels;
  let complete = ids.length <= limit;
  const rows = ids.slice(0, limit).map((nodeId): CatalogStatusRow => {
    const catalog = tables.catalogs.get(nodeId)!;
    const alive = tables.presence.get(nodeId);
    const withdrawn = tables.withdrawn(nodeId, catalog.digest);
    const online =
      !!alive &&
      alive.digest === catalog.digest &&
      !withdrawn &&
      live(catalog, now) &&
      live(alive, now);
    const all = online ? [...new Set(catalog.models)].sort() : [];
    const listed = all.slice(0, Math.max(0, models));
    if (listed.length < all.length) complete = false;
    models -= listed.length;
    return { nodeId, online, withdrawn, models: listed };
  });
  return { rows, complete };
}

function listMemory(tables: MemoryTables, query: SellerQuery): SellerRow[] {
  const { model, now, limit, after } = query;
  const rows: SellerRow[] = [];
  for (const [nodeId, catalog] of tables.catalogs) {
    const alive = tables.presence.get(nodeId);
    if (
      !alive ||
      !catalog.models.includes(model) ||
      alive.digest !== catalog.digest ||
      tables.withdrawn(nodeId, catalog.digest) ||
      !live(catalog, now) ||
      !live(alive, now)
    )
      continue;
    if (!after || nodeId > after.nodeId)
      rows.push({
        nodeId,
        catalogJson: catalog.json,
        presenceJson: alive.json,
      });
  }
  return rows.sort(compareRows).slice(0, limit);
}

function memoryState(
  node: MemoryNode,
  catalog: MemoryRecord | undefined,
  withdrawn: boolean,
): NodeState {
  return {
    lastSequence: node.lastSequence,
    catalog: catalog
      ? {
          sequence: catalog.sequence,
          expiresAt: catalog.expiresAt,
          withdrawn,
          json: catalog.json,
        }
      : null,
  };
}

function nextMemoryNode(
  node: MemoryNode | undefined,
  entry: StoredEntry,
): MemoryNode {
  const window = Math.floor(entry.admission.now / NODE_PUBLISH_QUOTA.windowMs);
  const count = node && node.publishWindow >= window ? node.publishCount : 0;
  if (count >= entry.admission.maxPublications)
    indexFail(INDEX_ERRORS.RATE_LIMITED);
  return {
    lastSequence: entry.sequence,
    retainUntil: Math.max(node?.retainUntil ?? 0, entry.retainUntil),
    publishWindow: Math.max(node?.publishWindow ?? window, window),
    publishCount: count + 1,
  };
}

function dropWithdrawals(
  withdrawals: Map<string, MemoryRecord>,
  catalogs: Map<string, MemoryRecord>,
  now: number,
) {
  for (const [nodeId, withdrawal] of withdrawals)
    if (
      withdrawal.expiresAt <= now &&
      catalogs.get(nodeId)?.digest !== withdrawal.digest
    )
      withdrawals.delete(nodeId);
}

// Same semantics as the D1 adapter, in process memory.
export function createMemoryStorage(): DiscoveryStorage {
  const nodes = new Map<string, MemoryNode>();
  const catalogs = new Map<string, MemoryRecord>();
  const presence = new Map<string, MemoryRecord>();
  const withdrawals = new Map<string, MemoryRecord>();
  const withdrawn = (nodeId: string, digest: string) =>
    withdrawals.get(nodeId)?.digest === digest;
  const uptime = memoryUptime();
  const tables = { catalogs, presence, withdrawn };
  function apply(entry: StoredEntry) {
    const row: MemoryRecord = {
      sequence: entry.sequence,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      digest: entry.digest,
      models: entry.models,
      json: entry.json,
      version: entry.version,
    };
    if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE)
      return presence.set(entry.nodeId, row);
    presence.delete(entry.nodeId);
    if (entry.kind === PUBLIC_RECORD_KINDS.CATALOG)
      return catalogs.set(entry.nodeId, row);
    return withdrawals.set(entry.nodeId, row);
  }
  return {
    async state(nodeId) {
      const node = nodes.get(nodeId);
      if (!node) return null;
      const catalog = catalogs.get(nodeId);
      return memoryState(
        node,
        catalog,
        !!catalog && withdrawn(nodeId, catalog.digest),
      );
    },
    async prune(now) {
      dropExpired(presence, now);
      dropExpired(catalogs, now);
      dropWithdrawals(withdrawals, catalogs, now);
      for (const [id, node] of nodes)
        if (node.retainUntil <= now) nodes.delete(id);
    },
    ...uptime,
    async put(entry) {
      const node = nodes.get(entry.nodeId);
      if (node && node.lastSequence >= entry.sequence) return false;
      const catalog = catalogs.get(entry.nodeId);
      if (
        entry.kind !== PUBLIC_RECORD_KINDS.CATALOG &&
        (!catalog ||
          catalog.digest !== entry.digest ||
          !live(catalog, entry.admission.now) ||
          withdrawn(entry.nodeId, entry.digest))
      )
        indexFail(INDEX_ERRORS.UNKNOWN_CATALOG);
      if (!node && nodes.size >= entry.admission.maxNodes)
        indexFail(INDEX_ERRORS.RATE_LIMITED);
      nodes.set(entry.nodeId, nextMemoryNode(node, entry));
      apply(entry);
      return true;
    },
    list: async (query) => listMemory(tables, query),
    activeVersions: async (now, limit, nodeId) =>
      versionsMemory(tables, now, limit, nodeId),
    models: async (now, limit) => modelsMemory(tables, now, limit),
    async catalogStatus(now, limit, maxModels) {
      return catalogStatusMemory(tables, now, limit, maxModels);
    },
    async count(now) {
      return (
        countLive(catalogs, now) +
        countLive(presence, now) +
        countLive(withdrawals, now)
      );
    },
  };
}
