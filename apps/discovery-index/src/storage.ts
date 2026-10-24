// Owns the discovery index storage contract and its in-process adapter for tests and local runs.
// Entries hold only signed public data; callers never pass IPs, headers or request metadata.
import {
  PUBLIC_RECORD_KINDS,
  type PublicRecordKind,
} from '@gyblos/protocol/constants';

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
  retainUntil: number;
  json: string;
}

export interface SellerCursor {
  issuedAt: number;
  nodeId: string;
}

export interface SellerRow {
  nodeId: string;
  issuedAt: number;
  catalogJson: string;
  presenceJson: string;
}

export interface SellerQuery {
  model: string;
  now: number;
  limit: number;
  after: SellerCursor | null;
}

export interface DiscoveryStorage {
  state(nodeId: string): Promise<NodeState | null>;
  // Number of tracked NodeIds (high-water marks), expired records included until pruned.
  nodeCount(): Promise<number>;
  // Drops expired records; keeps high-water marks until their retainUntil.
  prune(now: number): Promise<void>;
  // Atomic: true when applied, false when the sequence is not above the high-water mark.
  put(entry: StoredEntry): Promise<boolean>;
  // Live, non-withdrawn catalogs listing `model` with a live presence that references them,
  // ordered by presence issuedAt descending, then NodeId ascending.
  list(query: SellerQuery): Promise<SellerRow[]>;
  // Unexpired stored records of all three kinds.
  count(now: number): Promise<number>;
}

interface MemoryNode {
  lastSequence: number;
  retainUntil: number;
}

interface MemoryRecord {
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  digest: string;
  models: string[];
  json: string;
}

function compareRows(left: SellerRow, right: SellerRow) {
  if (left.issuedAt !== right.issuedAt) return right.issuedAt - left.issuedAt;
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

function afterCursor(row: SellerRow, after: SellerCursor | null) {
  return (
    !after ||
    row.issuedAt < after.issuedAt ||
    (row.issuedAt === after.issuedAt && row.nodeId > after.nodeId)
  );
}

const live = (row: MemoryRecord, now: number) =>
  row.issuedAt <= now && row.expiresAt > now;

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
    const row = {
      nodeId,
      issuedAt: alive.issuedAt,
      catalogJson: catalog.json,
      presenceJson: alive.json,
    };
    if (afterCursor(row, after)) rows.push(row);
  }
  return rows.sort(compareRows).slice(0, limit);
}

// Same semantics as the D1 adapter, in process memory.
export function createMemoryStorage(): DiscoveryStorage {
  const nodes = new Map<string, MemoryNode>();
  const catalogs = new Map<string, MemoryRecord>();
  const presence = new Map<string, MemoryRecord>();
  const withdrawals = new Map<string, MemoryRecord>();
  const withdrawn = (nodeId: string, digest: string) =>
    withdrawals.get(nodeId)?.digest === digest;
  function apply(entry: StoredEntry) {
    const row: MemoryRecord = {
      sequence: entry.sequence,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      digest: entry.digest,
      models: entry.models,
      json: entry.json,
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
      return {
        lastSequence: node.lastSequence,
        catalog: catalog
          ? {
              sequence: catalog.sequence,
              expiresAt: catalog.expiresAt,
              withdrawn: withdrawn(nodeId, catalog.digest),
              json: catalog.json,
            }
          : null,
      };
    },
    async nodeCount() {
      return nodes.size;
    },
    async prune(now) {
      dropExpired(presence, now);
      dropExpired(catalogs, now);
      dropExpired(withdrawals, now);
      for (const [id, node] of nodes)
        if (node.retainUntil <= now) nodes.delete(id);
    },
    async put(entry) {
      const node = nodes.get(entry.nodeId);
      if (node && node.lastSequence >= entry.sequence) return false;
      nodes.set(entry.nodeId, {
        lastSequence: entry.sequence,
        retainUntil: Math.max(node?.retainUntil ?? 0, entry.retainUntil),
      });
      apply(entry);
      return true;
    },
    async list(query) {
      return listMemory({ catalogs, presence, withdrawn }, query);
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
