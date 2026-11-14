// Builds atomic ORM writes: admission is part of the high-water upsert and every dependent write
// is conditional on winning that upsert. Application-side reads never reserve capacity.
import {
  and,
  eq,
  exists,
  gt,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import {
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';

import { NODE_PUBLISH_QUOTA } from './constants';
import type { D1Value, DiscoveryDatabase } from './d1-client';
import { catalogs, models, nodes, presence, withdrawals } from './schema';
import type { StoredEntry } from './storage';
import { withdrawnCatalog } from './storage-queries';

const bound = <T extends D1Value>(value: T, name: string) =>
  sql<T>`${value}`.as(name);

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
          nodeId: bound(entry.nodeId, 'nodeId'),
          lastSequence: bound(entry.sequence, 'sequence'),
          lastSignature: bound(entry.signature, 'signature'),
          retainUntil: bound(entry.retainUntil, 'retainUntil'),
          publishWindow: bound(window, 'publishWindow'),
          publishCount: bound(1, 'publishCount'),
        })
        .from(sql`(values (1))`)
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
        retainUntil: sql<number>`max(${nodes.retainUntil}, ${entry.retainUntil})`,
        publishWindow: sql<number>`max(${nodes.publishWindow}, ${window})`,
        publishCount: sql<number>`case when ${nodes.publishWindow} >= ${window} then ${nodes.publishCount} + 1 else 1 end`,
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
  sequence: bound(entry.sequence, 'sequence'),
  issuedAt: bound(entry.issuedAt, 'issuedAt'),
  expiresAt: bound(entry.expiresAt, 'expiresAt'),
  digest: bound(entry.digest, 'digest'),
  json: bound(entry.json, 'json'),
});
export function recordQueries(database: DiscoveryDatabase, entry: StoredEntry) {
  const won = writeGuard(database, entry);
  const fields = {
    sequence: entry.sequence,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
    digest: entry.digest,
    json: entry.json,
  };
  const source = database
    .select({ nodeId: bound(entry.nodeId, 'nodeId'), ...selectedRecord(entry) })
    .from(nodes)
    .where(and(eq(nodes.nodeId, entry.nodeId), won));
  const clearPresence = database
    .delete(presence)
    .where(and(eq(presence.nodeId, entry.nodeId), won));
  if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE)
    return [
      database
        .insert(presence)
        .select(source)
        .onConflictDoUpdate({ target: presence.nodeId, set: fields }),
    ];
  if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL)
    return [
      database
        .insert(withdrawals)
        .select(source)
        .onConflictDoUpdate({ target: withdrawals.nodeId, set: fields }),
      clearPresence,
    ];
  return [
    database
      .insert(catalogs)
      .select(
        database
          .select({
            nodeId: bound(entry.nodeId, 'nodeId'),
            owner: bound(entry.owner, 'owner'),
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
    database
      .insert(models)
      .select(
        database
          .select({
            nodeId: bound(entry.nodeId, 'nodeId'),
            modelId: sql<string>`value`.as('modelId'),
          })
          .from(sql`json_each(${JSON.stringify(entry.models)})`)
          .where(won),
      )
      .onConflictDoNothing(),
    clearPresence,
  ];
}
