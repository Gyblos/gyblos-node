// Owns the collector's typed tables, keys and indexes, matching migrations/ exactly (a test compares
// them). These declarations perform no client initialization or I/O.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const envelopes = sqliteTable(
  'collector_envelopes',
  {
    id: text('id').primaryKey(),
    uploaderNodeId: text('uploader_node_id').notNull(),
    role: text('role').notNull(),
    clientKind: text('client_kind').notNull(),
    appVersion: text('app_version').notNull(),
    platform: text('platform').notNull(),
    arch: text('arch').notNull(),
    nonce: text('nonce').notNull(),
    sentAt: integer('sent_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    skewMs: integer('skew_ms').notNull(),
    itemCount: integer('item_count').notNull(),
    signature: text('signature').notNull(),
    signedJson: text('signed_json').notNull(),
    insertedAt: integer('inserted_at').notNull(),
  },
  (table) => [
    unique().on(table.uploaderNodeId, table.nonce),
    index('collector_envelopes_by_received').on(table.receivedAt),
  ],
);

export const reports = sqliteTable(
  'collector_reports',
  {
    envelopeId: text('envelope_id').notNull(),
    receiptKey: text('receipt_key').notNull(),
    role: text('role').notNull(),
    fingerprint: text('fingerprint').notNull(),
    sellerDigest: text('seller_digest').notNull(),
    buyerDigest: text('buyer_digest'),
    merge: text('merge').notNull(),
    storedAt: integer('stored_at'),
    startedAt: integer('started_at'),
    offerJson: text('offer_json'),
    insertedAt: integer('inserted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.envelopeId, table.receiptKey] }),
    index('collector_reports_by_key').on(table.receiptKey),
  ],
);

export const receipts = sqliteTable(
  'collector_receipts',
  {
    receiptKey: text('receipt_key').primaryKey(),
    sellerNodeId: text('seller_node_id').notNull(),
    buyerNodeId: text('buyer_node_id').notNull(),
    requestId: text('request_id').notNull(),
    sellerDigest: text('seller_digest').notNull(),
    buyerDigest: text('buyer_digest'),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    paid: integer('paid').notNull(),
    owner: text('owner').notNull(),
    modelId: text('model_id').notNull(),
    variant: text('variant'),
    quantization: text('quantization'),
    reasoning: text('reasoning').notNull(),
    engineKind: text('engine_kind').notNull(),
    streaming: integer('streaming').notNull(),
    outcome: text('outcome').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens'),
    amountAtomic: text('amount_atomic').notNull(),
    feeAtomic: text('fee_atomic').notNull(),
    network: text('network'),
    asset: text('asset'),
    channelId: text('channel_id'),
    payer: text('payer'),
    sellerReceivedAt: integer('seller_received_at').notNull(),
    firstTokenMs: integer('first_token_ms'),
    totalMs: integer('total_ms').notNull(),
    receiptJson: text('receipt_json').notNull(),
    sellerReportedAt: integer('seller_reported_at'),
    buyerReportedAt: integer('buyer_reported_at'),
    insertedAt: integer('inserted_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('collector_receipts_by_seller_day').on(
      table.sellerNodeId,
      table.sellerReceivedAt,
    ),
    index('collector_receipts_by_model_day').on(
      table.modelId,
      table.sellerReceivedAt,
    ),
  ],
);

export const conflicts = sqliteTable(
  'collector_conflicts',
  {
    envelopeId: text('envelope_id').notNull(),
    receiptKey: text('receipt_key').notNull(),
    merge: text('merge').notNull(),
    fingerprint: text('fingerprint').notNull(),
    insertedAt: integer('inserted_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.envelopeId, table.receiptKey] })],
);

export const statusHistory = sqliteTable(
  'collector_status_history',
  {
    receiptKey: text('receipt_key').notNull(),
    status: text('status').notNull(),
    changedAt: integer('changed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.receiptKey, table.changedAt, table.status],
    }),
  ],
);
