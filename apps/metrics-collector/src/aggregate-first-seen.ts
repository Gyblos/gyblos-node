// Owns the first-seen upserts: the earliest headline receipt time of every seller, free buyer
// (NodeId), paid buyer (wallet) and model. A recomputed day can only move a first time earlier.
import { and, eq, min, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import {
  buyerIdentity,
  dayOf,
  headlineReceipt,
  inRange,
  literal,
  modelKey,
  ordered,
  type DayBounds,
} from './aggregate-sql';
import { FIRST_SEEN_KINDS } from './constants';
import type { CollectorDatabase } from './d1-client';
import { firstSeen, receipts } from './schema';

function upsert(
  database: CollectorDatabase,
  bounds: DayBounds,
  kind: string,
  id: SQL | SQLiteColumn,
  condition?: SQL,
) {
  const firstAt = min(receipts.sellerReceivedAt);
  return database
    .insert(firstSeen)
    .select(
      database
        .select(
          ordered(firstSeen, {
            kind: sql<string>`${literal(kind)}`,
            id: sql<string>`${id}`,
            firstDay: dayOf(sql`${firstAt}`),
            firstAt: sql<number>`${firstAt}`,
          }),
        )
        .from(receipts)
        .where(
          and(
            inRange(receipts.sellerReceivedAt, bounds),
            headlineReceipt,
            condition,
          ),
        )
        .groupBy(id),
    )
    .onConflictDoUpdate({
      target: [firstSeen.kind, firstSeen.id],
      set: {
        firstDay: sql`case when excluded.first_at < ${firstSeen.firstAt} then excluded.first_day else ${firstSeen.firstDay} end`,
        firstAt: sql`min(${firstSeen.firstAt}, excluded.first_at)`,
      },
    });
}

export function firstSeenUpserts(
  database: CollectorDatabase,
  bounds: DayBounds,
) {
  return [
    upsert(database, bounds, FIRST_SEEN_KINDS.SELLER, receipts.sellerNodeId),
    upsert(
      database,
      bounds,
      FIRST_SEEN_KINDS.BUYER_FREE,
      receipts.buyerNodeId,
      eq(receipts.paid, 0),
    ),
    upsert(
      database,
      bounds,
      FIRST_SEEN_KINDS.BUYER_PAID,
      buyerIdentity,
      eq(receipts.paid, 1),
    ),
    upsert(database, bounds, FIRST_SEEN_KINDS.MODEL, modelKey),
  ];
}
