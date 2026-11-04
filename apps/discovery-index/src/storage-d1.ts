// Owns the Cloudflare D1 adapter of the discovery storage contract (schema in migrations/, applied in order).
// Minimal local D1 interfaces stand in for @cloudflare/workers-types; rows are validated on read.
import {
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';

import type {
  DiscoveryStorage,
  NodeState,
  SellerRow,
  StoredEntry,
} from './storage';

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
// Two phases: the page CTE filters, sorts and limits keys from covering indexes only (migration
// 0002), then the signed JSON of just those rows is read by primary key. INDEXED BY pins the plan
// because D1 may have no statistics; the indexes must exist before this code is deployed. ?6 is the
// latest accepted issue time: records issued slightly ahead of this clock are listed, as at publish.
const LIST_SQL = `WITH page AS (
  SELECT p.node_id AS nodeId, p.issued_at AS issuedAt
  FROM discovery_catalog_models m
  JOIN discovery_catalogs c INDEXED BY discovery_catalogs_listing ON c.node_id = m.node_id
  JOIN discovery_presence p INDEXED BY discovery_presence_listing ON p.node_id = m.node_id AND p.catalog_digest = c.digest
  WHERE m.model_id = ?1 AND c.issued_at <= ?6 AND c.expires_at > ?2 AND p.issued_at <= ?6 AND p.expires_at > ?2
    AND NOT EXISTS (SELECT 1 FROM discovery_withdrawals w INDEXED BY discovery_withdrawals_listing
      WHERE w.node_id = c.node_id AND w.catalog_digest = c.digest)
    AND (?3 IS NULL OR p.issued_at < ?3 OR (p.issued_at = ?3 AND p.node_id > ?4))
  ORDER BY p.issued_at DESC, p.node_id ASC
  LIMIT ?5)
SELECT page.nodeId AS nodeId, page.issuedAt AS issuedAt, c.signed_json AS catalogJson, p.signed_json AS presenceJson
FROM page
JOIN discovery_catalogs c ON c.node_id = page.nodeId
JOIN discovery_presence p ON p.node_id = page.nodeId
ORDER BY page.issuedAt DESC, page.nodeId ASC`;
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

// One row per NodeId, updated in place under the guard: no delete and reinsert of the row and
// its index entries. ?1 is the NodeId; `values` are the remaining columns' parameters.
function upsertSql(table: string, columns: readonly string[], values: string) {
  const updates = columns
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  return `INSERT INTO ${table} (node_id, ${columns.join(', ')}) SELECT ?1, ${values} WHERE ${GUARD}
ON CONFLICT (node_id) DO UPDATE SET ${updates}`;
}

const RECORD_COLUMNS = [
  'sequence',
  'issued_at',
  'expires_at',
  'catalog_digest',
  'signed_json',
] as const;
const PRESENCE_SQL = upsertSql(
  'discovery_presence',
  RECORD_COLUMNS,
  '?2, ?4, ?5, ?6, ?7',
);
const WITHDRAWAL_SQL = upsertSql(
  'discovery_withdrawals',
  RECORD_COLUMNS,
  '?2, ?4, ?5, ?6, ?7',
);
const CATALOG_SQL = upsertSql(
  'discovery_catalogs',
  ['owner', 'sequence', 'issued_at', 'expires_at', 'digest', 'signed_json'],
  '?8, ?2, ?4, ?5, ?6, ?7',
);
// Model rows are (node_id, model_id) only, so a republish touches just the ids that changed;
// an unchanged model list writes no row.
const DROP_MODELS_SQL = `DELETE FROM discovery_catalog_models WHERE node_id = ?1
  AND model_id NOT IN (SELECT value FROM json_each(?4)) AND ${GUARD}`;
const ADD_MODELS_SQL = `INSERT INTO discovery_catalog_models (node_id, model_id) SELECT ?1, value FROM json_each(?4)
  WHERE ${GUARD} ON CONFLICT (node_id, model_id) DO NOTHING`;
const CLEAR_PRESENCE_SQL = `DELETE FROM discovery_presence WHERE node_id = ?1 AND ${GUARD}`;

function kindStatements(db: D1Database, entry: StoredEntry) {
  const head = [entry.nodeId, entry.sequence, entry.signature] as const;
  const record = [
    entry.issuedAt,
    entry.expiresAt,
    entry.digest,
    entry.json,
  ] as const;
  const clearPresence = db.prepare(CLEAR_PRESENCE_SQL).bind(...head);
  if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    return [db.prepare(PRESENCE_SQL).bind(...head, ...record)];
  if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL)
    return [db.prepare(WITHDRAWAL_SQL).bind(...head, ...record), clearPresence];
  const models = JSON.stringify(entry.models);
  return [
    db.prepare(CATALOG_SQL).bind(...head, ...record, entry.owner),
    db.prepare(DROP_MODELS_SQL).bind(...head, models),
    db.prepare(ADD_MODELS_SQL).bind(...head, models),
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
        .bind(
          model,
          now,
          after?.issuedAt ?? null,
          after?.nodeId ?? null,
          limit,
          now + CONTROL_LIMITS.clockSkewMs,
        )
        .all();
      return results.map(sellerRow);
    },
    async count(now) {
      const row = await db.prepare(COUNT_SQL).bind(now).first();
      return row ? integer(row.n) : 0;
    },
  };
}
