// Builds reads and expiry cleanup with the typed ORM schema. Listing sorts only index keys
// before reading the selected signed envelopes; no query contains request metadata.
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { CONTROL_LIMITS } from '@gyblos/protocol/constants';

import {
  DISCOVERY_LISTING_INDEXES,
  type DiscoveryListingIndex,
} from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { catalogs, models, nodes, presence, withdrawals } from './schema';
import type { SellerQuery } from './storage';

// SQLite index hints are expression fragments because Drizzle has no index-hint builder.
const indexed = (table: SQLiteTable, name: DiscoveryListingIndex) =>
  sql`${table} indexed by ${sql.identifier(name)}`;
export function withdrawnCatalog(database: DiscoveryDatabase) {
  return database
    .select({ nodeId: withdrawals.nodeId })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.nodeId, catalogs.nodeId),
        eq(withdrawals.digest, catalogs.digest),
      ),
    );
}
export function nodeStateQuery(database: DiscoveryDatabase, nodeId: string) {
  return database
    .select({
      lastSequence: nodes.lastSequence,
      publishWindow: nodes.publishWindow,
      publishCount: nodes.publishCount,
      sequence: catalogs.sequence,
      digest: catalogs.digest,
      issuedAt: catalogs.issuedAt,
      expiresAt: catalogs.expiresAt,
      json: catalogs.json,
      withdrawn: exists(withdrawnCatalog(database)).as('withdrawn'),
    })
    .from(nodes)
    .leftJoin(catalogs, eq(catalogs.nodeId, nodes.nodeId))
    .where(eq(nodes.nodeId, nodeId));
}
export function listingQuery(database: DiscoveryDatabase, query: SellerQuery) {
  const after = query.after;
  const page = database.$with('page').as(
    database
      .select({
        nodeId: sql<string>`${presence.nodeId}`.as('nodeId'),
        issuedAt: sql<number>`${presence.issuedAt}`.as('issuedAt'),
      })
      .from(models)
      .innerJoin(
        indexed(catalogs, DISCOVERY_LISTING_INDEXES.CATALOG),
        eq(catalogs.nodeId, models.nodeId),
      )
      .innerJoin(
        indexed(presence, DISCOVERY_LISTING_INDEXES.PRESENCE),
        and(
          eq(presence.nodeId, models.nodeId),
          eq(presence.digest, catalogs.digest),
        ),
      )
      .where(
        and(
          eq(models.modelId, query.model),
          lte(catalogs.issuedAt, query.now + CONTROL_LIMITS.clockSkewMs),
          gt(catalogs.expiresAt, query.now),
          lte(presence.issuedAt, query.now + CONTROL_LIMITS.clockSkewMs),
          gt(presence.expiresAt, query.now),
          notExists(
            database
              .select({
                nodeId: sql<string>`${withdrawals.nodeId}`.as('nodeId'),
              })
              .from(indexed(withdrawals, DISCOVERY_LISTING_INDEXES.WITHDRAWAL))
              .where(
                and(
                  eq(withdrawals.nodeId, catalogs.nodeId),
                  eq(withdrawals.digest, catalogs.digest),
                ),
              ),
          ),
          after
            ? or(
                lt(presence.issuedAt, after.issuedAt),
                and(
                  eq(presence.issuedAt, after.issuedAt),
                  gt(presence.nodeId, after.nodeId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(presence.issuedAt), asc(presence.nodeId))
      .limit(query.limit),
  );
  return database
    .with(page)
    .select({
      nodeId: page.nodeId,
      issuedAt: page.issuedAt,
      catalogJson: sql<string>`${catalogs.json}`.as('catalogJson'),
      presenceJson: sql<string>`${presence.json}`.as('presenceJson'),
    })
    .from(page)
    .innerJoin(catalogs, eq(catalogs.nodeId, page.nodeId))
    .innerJoin(presence, eq(presence.nodeId, page.nodeId))
    .orderBy(desc(page.issuedAt), asc(page.nodeId));
}
export function recordCountsQuery(database: DiscoveryDatabase, now: number) {
  return database
    .select({ n: sql<number>`${count()}` })
    .from(catalogs)
    .where(gt(catalogs.expiresAt, now))
    .unionAll(
      database
        .select({ n: sql<number>`${count()}` })
        .from(presence)
        .where(gt(presence.expiresAt, now)),
    )
    .unionAll(
      database
        .select({ n: sql<number>`${count()}` })
        .from(withdrawals)
        .where(gt(withdrawals.expiresAt, now)),
    );
}

export function modelsQuery(
  database: DiscoveryDatabase,
  now: number,
  limit: number,
) {
  const sellers = sql<number>`${countDistinct(models.nodeId)}`;
  return database
    .select({ modelId: models.modelId, sellers })
    .from(models)
    .innerJoin(catalogs, eq(catalogs.nodeId, models.nodeId))
    .innerJoin(
      presence,
      and(
        eq(presence.nodeId, models.nodeId),
        eq(presence.digest, catalogs.digest),
      ),
    )
    .where(
      and(
        lte(catalogs.issuedAt, now + CONTROL_LIMITS.clockSkewMs),
        gt(catalogs.expiresAt, now),
        lte(presence.issuedAt, now + CONTROL_LIMITS.clockSkewMs),
        gt(presence.expiresAt, now),
        notExists(withdrawnCatalog(database)),
      ),
    )
    .groupBy(models.modelId)
    .orderBy(desc(sellers), asc(models.modelId))
    .limit(limit);
}
export function pruneQueries(database: DiscoveryDatabase, now: number) {
  return [
    database.delete(presence).where(lte(presence.expiresAt, now)),
    database
      .delete(models)
      .where(
        inArray(
          models.nodeId,
          database
            .select({ nodeId: catalogs.nodeId })
            .from(catalogs)
            .where(lte(catalogs.expiresAt, now)),
        ),
      ),
    database.delete(catalogs).where(lte(catalogs.expiresAt, now)),
    database.delete(withdrawals).where(
      and(
        lte(withdrawals.expiresAt, now),
        notExists(
          database
            .select({ nodeId: catalogs.nodeId })
            .from(catalogs)
            .where(
              and(
                eq(catalogs.nodeId, withdrawals.nodeId),
                eq(catalogs.digest, withdrawals.digest),
                gt(catalogs.expiresAt, now),
              ),
            ),
        ),
      ),
    ),
    database.delete(nodes).where(lte(nodes.retainUntil, now)),
  ] as const;
}
