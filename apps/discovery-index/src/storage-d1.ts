// Owns the D1 storage port: typed ORM reads, atomic admission batches and runtime row validation.
// The schema and query builders contain no wallet, request metadata or network initialization.
import {
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';

import { INDEX_ERRORS, NODE_PUBLISH_QUOTA } from './constants';
import { createD1Orm, type D1Database, type D1Row } from './d1-client';
import { indexFail } from './errors';
import type {
  DiscoveryStorage,
  NodeState,
  SellerRow,
  StoredEntry,
} from './storage';
import {
  listingQuery,
  modelsQuery,
  nodeStateQuery,
  pruneQueries,
  recordCountsQuery,
} from './storage-queries';
import { admitNodeQuery, recordQueries } from './storage-writes';

export type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Row,
  D1Value,
} from './d1-client';

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

function referenceMissing(row: D1Row | undefined, entry: StoredEntry) {
  return (
    entry.kind !== PUBLIC_RECORD_KINDS.CATALOG &&
    (!row ||
      row.digest !== entry.digest ||
      integer(row.issuedAt) >
        entry.admission.now + CONTROL_LIMITS.clockSkewMs ||
      integer(row.expiresAt) <= entry.admission.now ||
      integer(row.withdrawn) !== 0)
  );
}
export function createD1Storage(client: D1Database): DiscoveryStorage {
  const database = createD1Orm(client);
  return {
    async state(nodeId) {
      const [row] = await nodeStateQuery(database, nodeId);
      return row ? nodeState(row) : null;
    },
    async prune(now) {
      await database.batch(pruneQueries(database, now));
    },
    async put(entry) {
      const [inserted] = await database.batch([
        admitNodeQuery(database, entry),
        ...recordQueries(database, entry),
      ]);
      if (inserted.length === 1) return true;
      const [current] = await nodeStateQuery(database, entry.nodeId);
      if (current && integer(current.lastSequence) >= entry.sequence)
        return false;
      if (referenceMissing(current, entry))
        return indexFail(INDEX_ERRORS.UNKNOWN_CATALOG);
      if (
        current &&
        integer(current.publishWindow) >=
          Math.floor(entry.admission.now / NODE_PUBLISH_QUOTA.windowMs) &&
        integer(current.publishCount) >= NODE_PUBLISH_QUOTA.limit
      )
        return indexFail(INDEX_ERRORS.RATE_LIMITED);
      return indexFail(
        entry.kind === PUBLIC_RECORD_KINDS.CATALOG
          ? INDEX_ERRORS.RATE_LIMITED
          : INDEX_ERRORS.UNKNOWN_CATALOG,
      );
    },
    async list(query) {
      return (await listingQuery(database, query)).map(sellerRow);
    },
    async count(now) {
      const rows = await recordCountsQuery(database, now);
      return rows.reduce((total, row) => total + integer(row.n), 0);
    },
    async models(now, limit) {
      return (await modelsQuery(database, now, limit)).map((row) => ({
        modelId: text(row.modelId),
        sellers: integer(row.sellers),
      }));
    },
  };
}
