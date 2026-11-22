// Owns the collector's typed tables, keys, indexes and checks, matching migrations/ exactly (a test
// compares them); drizzle-kit generates migrations from it. Historical D1 migrations retain physical
// WITHOUT ROWID layout, which Drizzle cannot declare. These declarations perform no client
// initialization or I/O.
import { eq, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

import type {
  PublicReceiptMerge,
  PublicReceiptStatus,
} from '@gyblos/core/constants';
import { PUBLIC_RECORD_LIMITS, type P2PRole } from '@gyblos/protocol/constants';
import type { TelemetryEvent } from '@gyblos/protocol/telemetry';

import type { EnvelopeKind } from './constants';

const nodeIdCharacters =
  PUBLIC_RECORD_LIMITS.publicKeyBytes *
  PUBLIC_RECORD_LIMITS.hexCharactersPerByte;

export const envelopes = sqliteTable(
  'collector_envelopes',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<EnvelopeKind>().notNull(),
    uploaderNodeId: text('uploader_node_id').notNull(),
    role: text('role').$type<P2PRole>().notNull(),
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
    // Inlined: drizzle-kit writes check expressions into migration SQL, where a bound parameter
    // would be a bare `?`.
    check(
      'collector_envelopes_uploader_node_id',
      eq(sql`length(${table.uploaderNodeId})`, nodeIdCharacters).inlineParams(),
    ),
  ],
);

export const reports = sqliteTable(
  'collector_reports',
  {
    envelopeId: text('envelope_id').notNull(),
    receiptKey: text('receipt_key').notNull(),
    role: text('role').$type<P2PRole>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    sellerDigest: text('seller_digest').notNull(),
    buyerDigest: text('buyer_digest'),
    merge: text('merge').$type<PublicReceiptMerge>().notNull(),
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
    status: text('status').$type<PublicReceiptStatus>().notNull(),
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
    index('collector_receipts_by_updated').on(table.updatedAt),
    index('collector_receipts_by_received').on(table.sellerReceivedAt),
    index('collector_receipts_by_request').on(
      table.requestId,
      table.sellerNodeId,
    ),
  ],
);

export const conflicts = sqliteTable(
  'collector_conflicts',
  {
    envelopeId: text('envelope_id').notNull(),
    receiptKey: text('receipt_key').notNull(),
    merge: text('merge').$type<PublicReceiptMerge>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    insertedAt: integer('inserted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.envelopeId, table.receiptKey] }),
    index('collector_conflicts_by_inserted').on(table.insertedAt),
  ],
);

export const statusHistory = sqliteTable(
  'collector_status_history',
  {
    receiptKey: text('receipt_key').notNull(),
    status: text('status').$type<PublicReceiptStatus>().notNull(),
    changedAt: integer('changed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.receiptKey, table.changedAt, table.status],
    }),
  ],
);

export const observations = sqliteTable(
  'collector_observations',
  {
    eventKey: text('event_key').primaryKey(),
    envelopeId: text('envelope_id').notNull(),
    eventIndex: integer('event_index').notNull(),
    type: text('type').$type<TelemetryEvent['type']>().notNull(),
    at: integer('at').notNull(),
    requestId: text('request_id'),
    sellerNodeId: text('seller_node_id'),
    modelId: text('model_id').notNull(),
    recordJson: text('record_json').notNull(),
    insertedAt: integer('inserted_at').notNull(),
  },
  (table) => [
    index('collector_observations_by_envelope').on(
      table.envelopeId,
      table.eventIndex,
    ),
    index('collector_observations_by_type_time').on(table.type, table.at),
    index('collector_observations_by_request').on(table.requestId),
    index('collector_observations_by_inserted').on(table.insertedAt),
    index('collector_observations_by_at').on(table.at),
  ],
);

// Aggregate tables (#351), recomputed from the raw tables above.
export {
  aggDemandDaily,
  aggDirtyDays,
  aggNetworkDaily,
  aggObservedDaily,
  aggSellerBuyersDaily,
  aggSellerDaily,
  aggSellerHourly,
  aggState,
  firstSeen,
} from './schema-aggregates';

// Breakdowns of the network stats: origin of requests and failure reasons.
export { aggFailuresDaily, aggOriginDaily } from './schema-breakdowns';

// Per-model observations: buyer first token and engine speed, per paid flag.
export { aggModelObservedDaily } from './schema-model-observed';

// Chain index tables (#349).
export {
  aggChainDaily,
  aggChainDirtyDays,
  aggChainState,
  chainChannels,
  chainCursor,
  chainInstructions,
  chainProgramDaily,
  chainTokenDeltas,
  chainTxs,
} from './schema-chain';
