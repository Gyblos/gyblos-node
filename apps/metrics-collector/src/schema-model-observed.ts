// Owns the typed per-model observations table, matching migrations/0007 exactly (the schema test
// compares them). These declarations perform no I/O.
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const aggModelObservedDaily = sqliteTable(
  'collector_agg_model_observed_daily',
  {
    day: text('day').notNull(),
    modelId: text('model_id').notNull(),
    variant: text('variant').notNull(),
    quantization: text('quantization').notNull(),
    paid: integer('paid').notNull(),
    buyerFirstTokenHist: text('buyer_first_token_hist').notNull(),
    engineTpsHist: text('engine_tps_hist').notNull(),
    formulaVersion: integer('formula_version').notNull(),
    aggregatedAt: integer('aggregated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.day,
        table.modelId,
        table.variant,
        table.quantization,
        table.paid,
      ],
    }),
  ],
);
