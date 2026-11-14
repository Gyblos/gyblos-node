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
} from 'drizzle-orm';

import { CONTROL_LIMITS } from '@gyblos/protocol/constants';

import { DISCOVERY_LISTING_INDEXES } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import { catalogs, models, nodes, presence, withdrawals } from './schema';
import { columnField, coveringIndex } from './sqlite-expressions';
import type { SellerQuery } from './storage';

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
        nodeId: columnField(presence.nodeId, 'nodeId'),
        issuedAt: columnField(presence.issuedAt, 'issuedAt'),
      })
      .from(models)
      .innerJoin(
        coveringIndex(catalogs, DISCOVERY_LISTING_INDEXES.CATALOG),
        eq(catalogs.nodeId, models.nodeId),
      )
      .innerJoin(
        coveringIndex(presence, DISCOVERY_LISTING_INDEXES.PRESENCE),
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
                nodeId: columnField(withdrawals.nodeId, 'nodeId'),
              })
              .from(
                coveringIndex(
                  withdrawals,
                  DISCOVERY_LISTING_INDEXES.WITHDRAWAL,
                ),
              )
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
      catalogJson: columnField(catalogs.json, 'catalogJson'),
      presenceJson: columnField(presence.json, 'presenceJson'),
    })
    .from(page)
    .innerJoin(catalogs, eq(catalogs.nodeId, page.nodeId))
    .innerJoin(presence, eq(presence.nodeId, page.nodeId))
    .orderBy(desc(page.issuedAt), asc(page.nodeId));
}
export function recordCountsQuery(database: DiscoveryDatabase, now: number) {
  return database
    .select({ n: count().as('n') })
    .from(catalogs)
    .where(gt(catalogs.expiresAt, now))
    .unionAll(
      database
        .select({ n: count().as('n') })
        .from(presence)
        .where(gt(presence.expiresAt, now)),
    )
    .unionAll(
      database
        .select({ n: count().as('n') })
        .from(withdrawals)
        .where(gt(withdrawals.expiresAt, now)),
    );
}

export function modelsQuery(
  database: DiscoveryDatabase,
  now: number,
  limit: number,
) {
  const sellers = countDistinct(models.nodeId).as('sellers');
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
