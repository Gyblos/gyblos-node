// Owns the typed breakdown tables (origin of requests, failure reasons), matching migrations/0005
// exactly (the schema test compares them). These declarations perform no I/O.
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const aggOriginDaily = sqliteTable(
  'collector_agg_origin_daily',
  {
    day: text('day').notNull(),
    paid: integer('paid').notNull(),
    clientKind: text('client_kind').notNull(),
    requests: integer('requests').notNull(),
    completed: integer('completed').notNull(),
    failed: integer('failed').notNull(),
    cancelled: integer('cancelled').notNull(),
    buyers: integer('buyers').notNull(),
    formulaVersion: integer('formula_version').notNull(),
    aggregatedAt: integer('aggregated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.paid, table.clientKind] }),
  ],
);

export const aggFailuresDaily = sqliteTable(
  'collector_agg_failures_daily',
  {
    day: text('day').notNull(),
    side: text('side').notNull(),
    clientKind: text('client_kind').notNull(),
    event: text('event').notNull(),
    reason: text('reason').notNull(),
    events: integer('events').notNull(),
    buyers: integer('buyers').notNull(),
    formulaVersion: integer('formula_version').notNull(),
    aggregatedAt: integer('aggregated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.day,
        table.side,
        table.clientKind,
        table.event,
        table.reason,
      ],
    }),
  ],
);
