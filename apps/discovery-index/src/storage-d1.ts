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
import { readOfferHistory } from './storage-history';
import {
  activeVersionsQuery,
  catalogStatusQuery,
  listingQuery,
  modelsQuery,
  nodeStateQuery,
  onlineModelsQuery,
  pruneQueries,
  recordCountsQuery,
} from './storage-queries';
import { admitNodeQuery, recordQueries } from './storage-writes';
import { createD1Uptime, integer, text } from './uptime-d1';

export type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Row,
  D1Value,
} from './d1-client';

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
    catalogJson: text(row.catalogJson),
    presenceJson: text(row.presenceJson),
  };
}

function modelRow(row: D1Row) {
  return { modelId: text(row.modelId), sellers: integer(row.sellers) };
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
async function readActiveVersions(
  database: ReturnType<typeof createD1Orm>,
  now: number,
  limit: number,
  nodeId?: string,
) {
  return (await activeVersionsQuery(database, now, limit, nodeId)).map(
    (row) => ({
      nodeId: text(row.nodeId),
      version:
        row.versionSequence === row.sequence && row.version !== null
          ? text(row.version)
          : null,
    }),
  );
}
export function createD1Storage(client: D1Database): DiscoveryStorage {
  const database = createD1Orm(client);
  return {
    ...createD1Uptime(database),
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
        integer(current.publishCount) >= entry.admission.maxPublications
      )
        return indexFail(INDEX_ERRORS.RATE_LIMITED);
      return indexFail(
        entry.kind === PUBLIC_RECORD_KINDS.CATALOG
          ? INDEX_ERRORS.RATE_LIMITED
          : INDEX_ERRORS.UNKNOWN_CATALOG,
      );
    },
    offerHistory: (query) => readOfferHistory(database, query),
    async list(query) {
      return (await listingQuery(database, query)).map(sellerRow);
    },
    async count(now) {
      const rows = await recordCountsQuery(database, now);
      return rows.reduce((total, row) => total + integer(row.n), 0);
    },
    activeVersions: (now, limit, nodeId) =>
      readActiveVersions(database, now, limit, nodeId),
    async models(now, limit) {
      return (await modelsQuery(database, now, limit)).map(modelRow);
    },
    async catalogStatus(now, limit, maxModels) {
      // One row past each cap tells whether the cap cut the answer.
      const [rows, listed] = await Promise.all([
        catalogStatusQuery(database, now, limit + 1),
        onlineModelsQuery(database, now, maxModels + 1),
      ]);
      const byNode = new Map<string, string[]>();
      for (const row of listed.slice(0, maxModels)) {
        const nodeId = text(row.nodeId);
        byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), text(row.modelId)]);
      }
      return {
        complete: rows.length <= limit && listed.length <= maxModels,
        rows: rows.slice(0, limit).map((row) => {
          const nodeId = text(row.nodeId);
          const withdrawn = integer(row.withdrawn) !== 0;
          const online =
            integer(row.alive) !== 0 &&
            !withdrawn &&
            integer(row.issuedAt) <= now + CONTROL_LIMITS.clockSkewMs &&
            integer(row.expiresAt) > now;
          return {
            nodeId,
            online,
            withdrawn,
            models: online ? (byNode.get(nodeId) ?? []) : [],
          };
        }),
      };
    },
  };
}
