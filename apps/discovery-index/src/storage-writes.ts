// Builds atomic ORM writes: admission is part of the high-water upsert and every dependent write
// is conditional on winning that upsert. Application-side reads never reserve capacity.
import {
  and,
  eq,
  exists,
  gt,
  isNotNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/sqlite-core';

import {
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';

import { NODE_PUBLISH_QUOTA } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { catalogs, models, nodes, presence, withdrawals } from './schema';
import {
  maximum,
  publicationCount,
  singleRow,
  valueField,
} from './sqlite-expressions';
import type { StoredEntry } from './storage';
import { historyQueries } from './storage-history';
import { withdrawnCatalog } from './storage-queries';

function currentReference(database: DiscoveryDatabase, entry: StoredEntry) {
  return database
    .select({ nodeId: catalogs.nodeId })
    .from(catalogs)
    .where(
      and(
        eq(catalogs.nodeId, entry.nodeId),
        eq(catalogs.digest, entry.digest),
        lte(
          catalogs.issuedAt,
          entry.admission.now + CONTROL_LIMITS.clockSkewMs,
        ),
        gt(catalogs.expiresAt, entry.admission.now),
        notExists(withdrawnCatalog(database)),
      ),
    );
}

export function admitNodeQuery(
  database: DiscoveryDatabase,
  entry: StoredEntry,
) {
  const window = Math.floor(entry.admission.now / NODE_PUBLISH_QUOTA.windowMs);
  const existing = database
    .select({ nodeId: nodes.nodeId })
    .from(nodes)
    .where(eq(nodes.nodeId, entry.nodeId));
  return database
    .insert(nodes)
    .select(
      database
        .select({
          nodeId: valueField(entry.nodeId, 'nodeId'),
          lastSequence: valueField(entry.sequence, 'sequence'),
          lastSignature: valueField(entry.signature, 'signature'),
          retainUntil: valueField(entry.retainUntil, 'retainUntil'),
          publishWindow: valueField(window, 'publishWindow'),
          publishCount: valueField(1, 'publishCount'),
        })
        .from(singleRow())
        .where(
          and(
            or(
              exists(existing),
              lt(database.$count(nodes), entry.admission.maxNodes),
            ),
            entry.kind === PUBLIC_RECORD_KINDS.CATALOG
              ? undefined
              : exists(currentReference(database, entry)),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: nodes.nodeId,
      set: {
        lastSequence: entry.sequence,
        lastSignature: entry.signature,
        retainUntil: maximum(nodes.retainUntil, entry.retainUntil),
        publishWindow: maximum(nodes.publishWindow, window),
        publishCount: publicationCount(
          nodes.publishWindow,
          nodes.publishCount,
          window,
        ),
      },
      setWhere: and(
        lt(nodes.lastSequence, entry.sequence),
        or(
          lt(nodes.publishWindow, window),
          lt(nodes.publishCount, entry.admission.maxPublications),
        ),
      ),
    })
    .returning({ nodeId: nodes.nodeId });
}
function writeGuard(database: DiscoveryDatabase, entry: StoredEntry) {
  return exists(
    database
      .select({ nodeId: nodes.nodeId })
      .from(nodes)
      .where(
        and(
          eq(nodes.nodeId, entry.nodeId),
          eq(nodes.lastSequence, entry.sequence),
          eq(nodes.lastSignature, entry.signature),
        ),
      ),
  );
}
const selectedRecord = (entry: StoredEntry) => ({
  sequence: valueField(entry.sequence, 'sequence'),
  issuedAt: valueField(entry.issuedAt, 'issuedAt'),
  expiresAt: valueField(entry.expiresAt, 'expiresAt'),
  digest: valueField(entry.digest, 'digest'),
  json: valueField(entry.json, 'json'),
});

function catalogModelQueries(database: DiscoveryDatabase, entry: StoredEntry) {
  const admitted = database.$with('admitted_models').as(
    database
      .select({ nodeId: nodes.nodeId })
      .from(nodes)
      .where(
        and(
          eq(nodes.nodeId, entry.nodeId),
          eq(nodes.lastSequence, entry.sequence),
          eq(nodes.lastSignature, entry.signature),
        ),
      )
      // nodeId is unique. LIMIT preserves cardinality and prevents SQLite from inlining this
      // admission lookup into every UNION branch of a large catalog.
      .limit(1),
  );
  const [first, second, ...rest] = entry.models.map((modelId) =>
    database
      .select({
        nodeId: admitted.nodeId,
        modelId: valueField(modelId, 'modelId'),
      })
      .from(admitted)
      // An explicit WHERE disambiguates SQLite's INSERT SELECT ON CONFLICT grammar.
      .where(isNotNull(admitted.nodeId)),
  );
  if (!first) return [];
  const source = second ? unionAll(first, second, ...rest) : first;
  // Guard, materialization limit and at most 64 models use 68 of D1's 100 bound parameters.
  return [
    database.with(admitted).insert(models).select(source).onConflictDoNothing(),
  ];
}
function recordFields(entry: StoredEntry) {
  return {
    sequence: entry.sequence,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
    digest: entry.digest,
    json: entry.json,
  };
}
function presenceQuery(database: DiscoveryDatabase, entry: StoredEntry) {
  const won = writeGuard(database, entry);
  return database
    .insert(presence)
    .select(
      database
        .select({
          nodeId: valueField(entry.nodeId, 'nodeId'),
          ...selectedRecord(entry),
          releaseVersion: valueField(entry.version ?? null, 'releaseVersion'),
          versionSequence: valueField(entry.sequence, 'versionSequence'),
        })
        .from(nodes)
        .where(and(eq(nodes.nodeId, entry.nodeId), won)),
    )
    .onConflictDoUpdate({
      target: presence.nodeId,
      setWhere: lt(presence.sequence, entry.sequence),
      set: {
        ...recordFields(entry),
        releaseVersion: entry.version ?? null,
        versionSequence: entry.sequence,
      },
    });
}
export function recordQueries(database: DiscoveryDatabase, entry: StoredEntry) {
  if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    return [presenceQuery(database, entry)];
  const won = writeGuard(database, entry);
  const fields = recordFields(entry);
  const source = database
    .select({
      nodeId: valueField(entry.nodeId, 'nodeId'),
      ...selectedRecord(entry),
    })
    .from(nodes)
    .where(and(eq(nodes.nodeId, entry.nodeId), won));
  const clearPresence = database
    .delete(presence)
    .where(and(eq(presence.nodeId, entry.nodeId), won));
  if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL)
    return [
      database
        .insert(withdrawals)
        .select(source)
        .onConflictDoUpdate({ target: withdrawals.nodeId, set: fields }),
      clearPresence,
      ...historyQueries(database, entry, won),
    ];
  return [
    database
      .insert(catalogs)
      .select(
        database
          .select({
            nodeId: valueField(entry.nodeId, 'nodeId'),
            owner: valueField(entry.owner, 'owner'),
            ...selectedRecord(entry),
          })
          .from(nodes)
          .where(and(eq(nodes.nodeId, entry.nodeId), won)),
      )
      .onConflictDoUpdate({
        target: catalogs.nodeId,
        set: { owner: entry.owner, ...fields },
      }),
    database
      .delete(models)
      .where(
        and(
          eq(models.nodeId, entry.nodeId),
          notInArray(models.modelId, entry.models),
          won,
        ),
      ),
    ...catalogModelQueries(database, entry),
    clearPresence,
    ...historyQueries(database, entry, won),
  ];
}
