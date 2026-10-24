// Owns the Cloudflare D1 adapter of the discovery storage contract (migrations/0001_discovery_index.sql).
// Minimal local D1 interfaces stand in for @cloudflare/workers-types; rows are validated on read.
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import type {
  DiscoveryStorage,
  NodeState,
  SellerRow,
  StoredEntry,
} from './storage.js';

export type D1Value = string | number | null;
export type D1Row = Record<string, unknown>;

export interface D1Result {
  meta: { changes: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first(): Promise<D1Row | null>;
  all(): Promise<{ results: D1Row[] }>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  // D1 runs a batch as one transaction.
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

// Storage rows are our own, but a corrupted row must fail closed (503), not be trusted.
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Unexpected discovery storage row.');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError('Unexpected discovery storage row.');
  return value;
}

const STATE_SQL = `SELECT n.last_sequence AS lastSequence, c.sequence AS sequence, c.expires_at AS expiresAt,
  c.signed_json AS json, EXISTS (SELECT 1 FROM discovery_withdrawals w WHERE w.node_id = n.node_id AND w.catalog_digest = c.digest) AS withdrawn
FROM discovery_nodes n LEFT JOIN discovery_catalogs c ON c.node_id = n.node_id WHERE n.node_id = ?1`;
const LIST_SQL = `SELECT p.node_id AS nodeId, p.issued_at AS issuedAt, c.signed_json AS catalogJson, p.signed_json AS presenceJson
FROM discovery_catalog_models m
JOIN discovery_catalogs c ON c.node_id = m.node_id
JOIN discovery_presence p ON p.node_id = m.node_id AND p.catalog_digest = c.digest
WHERE m.model_id = ?1 AND c.issued_at <= ?2 AND c.expires_at > ?2 AND p.issued_at <= ?2 AND p.expires_at > ?2
  AND NOT EXISTS (SELECT 1 FROM discovery_withdrawals w WHERE w.node_id = c.node_id AND w.catalog_digest = c.digest)
  AND (?3 IS NULL OR p.issued_at < ?3 OR (p.issued_at = ?3 AND p.node_id > ?4))
ORDER BY p.issued_at DESC, p.node_id ASC
LIMIT ?5`;
const COUNT_SQL = `SELECT (SELECT count(*) FROM discovery_catalogs WHERE expires_at > ?1)
  + (SELECT count(*) FROM discovery_presence WHERE expires_at > ?1)
  + (SELECT count(*) FROM discovery_withdrawals WHERE expires_at > ?1) AS n`;
const UPSERT_NODE_SQL = `INSERT INTO discovery_nodes (node_id, last_sequence, last_signature, retain_until) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (node_id) DO UPDATE SET last_sequence = excluded.last_sequence, last_signature = excluded.last_signature,
retain_until = max(discovery_nodes.retain_until, excluded.retain_until) WHERE excluded.last_sequence > discovery_nodes.last_sequence`;
// Every later statement of a put applies only if this batch's upsert won the high-water mark.
const GUARD =
  'EXISTS (SELECT 1 FROM discovery_nodes WHERE node_id = ?1 AND last_sequence = ?2 AND last_signature = ?3)';
// Models go by key before their catalogs. A withdrawal never outlives its catalog and
// retain_until exceeds every expiry, so expiry alone drops it. Each DELETE is index-driven.
const PRUNE_SQL = [
  'DELETE FROM discovery_presence WHERE expires_at <= ?1',
  'DELETE FROM discovery_catalog_models WHERE node_id IN (SELECT node_id FROM discovery_catalogs WHERE expires_at <= ?1)',
  'DELETE FROM discovery_catalogs WHERE expires_at <= ?1',
  'DELETE FROM discovery_withdrawals WHERE expires_at <= ?1',
  'DELETE FROM discovery_nodes WHERE retain_until <= ?1',
];

function nodeState(row: D1Row): NodeState {
  return {
    lastSequence: integer(row.lastSequence),
    catalog:
      row.json === null
        ? null
        : {
            sequence: integer(row.sequence),
            expiresAt: integer(row.expiresAt),
            withdrawn: integer(row.withdrawn) !== 0,
            json: text(row.json),
          },
  };
}

function sellerRow(row: D1Row): SellerRow {
  return {
    nodeId: text(row.nodeId),
    issuedAt: integer(row.issuedAt),
    catalogJson: text(row.catalogJson),
    presenceJson: text(row.presenceJson),
  };
}

function kindStatements(db: D1Database, entry: StoredEntry) {
  const head = [entry.nodeId, entry.sequence, entry.signature] as const;
  const record = [
    entry.issuedAt,
    entry.expiresAt,
    entry.digest,
    entry.json,
  ] as const;
  const clearPresence = db
    .prepare(`DELETE FROM discovery_presence WHERE node_id = ?1 AND ${GUARD}`)
    .bind(...head);
  if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    return [
      db
        .prepare(
          `INSERT OR REPLACE INTO discovery_presence (node_id, sequence, issued_at, expires_at, catalog_digest, signed_json) SELECT ?1, ?2, ?4, ?5, ?6, ?7 WHERE ${GUARD}`,
        )
        .bind(...head, ...record),
    ];
  if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL)
    return [
      db
        .prepare(
          `INSERT OR REPLACE INTO discovery_withdrawals (node_id, sequence, issued_at, expires_at, catalog_digest, signed_json) SELECT ?1, ?2, ?4, ?5, ?6, ?7 WHERE ${GUARD}`,
        )
        .bind(...head, ...record),
      clearPresence,
    ];
  return [
    db
      .prepare(
        `INSERT OR REPLACE INTO discovery_catalogs (node_id, owner, sequence, issued_at, expires_at, digest, signed_json) SELECT ?1, ?8, ?2, ?4, ?5, ?6, ?7 WHERE ${GUARD}`,
      )
      .bind(...head, ...record, entry.owner),
    db
      .prepare(
        `DELETE FROM discovery_catalog_models WHERE node_id = ?1 AND ${GUARD}`,
      )
      .bind(...head),
    db
      .prepare(
        `INSERT INTO discovery_catalog_models (node_id, model_id) SELECT ?1, value FROM json_each(?4) WHERE ${GUARD}`,
      )
      .bind(...head, JSON.stringify(entry.models)),
    clearPresence,
  ];
}

export function createD1Storage(db: D1Database): DiscoveryStorage {
  return {
    async state(nodeId) {
      const row = await db.prepare(STATE_SQL).bind(nodeId).first();
      return row ? nodeState(row) : null;
    },
    async nodeCount() {
      const row = await db
        .prepare('SELECT count(*) AS n FROM discovery_nodes')
        .first();
      return row ? integer(row.n) : 0;
    },
    async prune(now) {
      await db.batch(PRUNE_SQL.map((sql) => db.prepare(sql).bind(now)));
    },
    async put(entry) {
      const upsert = db
        .prepare(UPSERT_NODE_SQL)
        .bind(entry.nodeId, entry.sequence, entry.signature, entry.retainUntil);
      // The guard sees the upsert result because the batch is one transaction.
      const [result] = await db.batch([upsert, ...kindStatements(db, entry)]);
      return result?.meta.changes === 1;
    },
    async list({ model, now, limit, after }) {
      const { results } = await db
        .prepare(LIST_SQL)
        .bind(model, now, after?.issuedAt ?? null, after?.nodeId ?? null, limit)
        .all();
      return results.map(sellerRow);
    },
    async count(now) {
      const row = await db.prepare(COUNT_SQL).bind(now).first();
      return row ? integer(row.n) : 0;
    },
  };
}
