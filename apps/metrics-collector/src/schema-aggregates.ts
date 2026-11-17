// Owns the typed aggregate tables (#351), matching migrations/0002 exactly (the schema test compares
// them). Every row is recomputed from raw rows; these declarations perform no I/O.
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// Additive receipt columns shared by the seller hourly, seller daily and network tables. Fresh
// builders per table, as Drizzle requires.
function receiptTotalColumns() {
  return {
    paid: integer('paid').notNull(),
    bilateral: integer('bilateral').notNull(),
    sellerOnly: integer('seller_only').notNull(),
    disputed: integer('disputed').notNull(),
    completed: integer('completed').notNull(),
    failed: integer('failed').notNull(),
    cancelled: integer('cancelled').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens').notNull(),
    reasoningUnknown: integer('reasoning_unknown').notNull(),
    amountAtomic: integer('amount_atomic').notNull(),
    feeAtomic: integer('fee_atomic').notNull(),
    firstTokenHist: text('first_token_hist').notNull(),
    totalHist: text('total_hist').notNull(),
  };
}
function version() {
  return {
    formulaVersion: integer('formula_version').notNull(),
    aggregatedAt: integer('aggregated_at').notNull(),
  };
}
function sellerModel() {
  return {
    sellerNodeId: text('seller_node_id').notNull(),
    modelId: text('model_id').notNull(),
    variant: text('variant').notNull(),
    quantization: text('quantization').notNull(),
  };
}

export const aggState = sqliteTable('collector_agg_state', {
  id: integer('id').primaryKey(),
  scannedAt: integer('scanned_at').notNull(),
  formulaVersion: integer('formula_version').notNull(),
});

export const aggDirtyDays = sqliteTable('collector_agg_dirty_days', {
  day: text('day').primaryKey(),
});

export const aggSellerDaily = sqliteTable(
  'collector_agg_seller_daily',
  {
    day: text('day').notNull(),
    ...sellerModel(),
    ...receiptTotalColumns(),
    ...version(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.day,
        table.sellerNodeId,
        table.modelId,
        table.variant,
        table.quantization,
        table.paid,
      ],
    }),
  ],
);

export const aggSellerHourly = sqliteTable(
  'collector_agg_seller_hourly',
  {
    hour: integer('hour').notNull(),
    ...sellerModel(),
    ...receiptTotalColumns(),
    ...version(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.hour,
        table.sellerNodeId,
        table.modelId,
        table.variant,
        table.quantization,
        table.paid,
      ],
    }),
  ],
);

export const aggSellerBuyersDaily = sqliteTable(
  'collector_agg_seller_buyers_daily',
  {
    day: text('day').notNull(),
    sellerNodeId: text('seller_node_id').notNull(),
    paid: integer('paid').notNull(),
    buyers: integer('buyers').notNull(),
    ...version(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.sellerNodeId, table.paid] }),
  ],
);

export const aggNetworkDaily = sqliteTable(
  'collector_agg_network_daily',
  {
    day: text('day').notNull(),
    ...receiptTotalColumns(),
    conflicts: integer('conflicts').notNull(),
    activeSellers: integer('active_sellers').notNull(),
    buyers: integer('buyers').notNull(),
    modelsServed: integer('models_served').notNull(),
    ...version(),
  },
  (table) => [primaryKey({ columns: [table.day, table.paid] })],
);

export const aggObservedDaily = sqliteTable('collector_agg_observed_daily', {
  day: text('day').primaryKey(),
  buyerFirstTokenHist: text('buyer_first_token_hist').notNull(),
  buyerTotalHist: text('buyer_total_hist').notNull(),
  routeDirect: integer('route_direct').notNull(),
  routeRelay: integer('route_relay').notNull(),
  routeUnknown: integer('route_unknown').notNull(),
  ...version(),
});

export const aggDemandDaily = sqliteTable(
  'collector_agg_demand_daily',
  {
    day: text('day').notNull(),
    modelId: text('model_id').notNull(),
    unserved: integer('unserved').notNull(),
    refusedBeforeSelection: integer('refused_before_selection').notNull(),
    connectFailed: integer('connect_failed').notNull(),
    ...version(),
  },
  (table) => [primaryKey({ columns: [table.day, table.modelId] })],
);

export const firstSeen = sqliteTable(
  'collector_first_seen',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    firstDay: text('first_day').notNull(),
    firstAt: integer('first_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.id] })],
);

// The receipt total columns, in table order: the one list the aggregation, the reads and the response
// shapes follow.
export type ReceiptTotalKey = keyof ReturnType<typeof receiptTotalColumns>;
export const RECEIPT_TOTAL_KEYS = Object.keys(
  receiptTotalColumns(),
) as ReceiptTotalKey[];
// Histogram columns among them: summed bucket by bucket, never as numbers.
export const HISTOGRAM_KEYS: ReadonlySet<ReceiptTotalKey> = new Set([
  'firstTokenHist',
  'totalHist',
]);
export type ReceiptTotals = Pick<
  typeof aggSellerDaily.$inferSelect,
  ReceiptTotalKey
>;
