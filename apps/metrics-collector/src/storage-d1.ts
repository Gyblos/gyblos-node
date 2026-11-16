// Owns the D1 storage port: one transactional batch per upload. First versions, status history and
// conflicts are decided in SQL against the row at write time, so concurrent uploads cannot replace a
// first seller record or buyer attestation, nor lose the evidence of a conflict.
import {
  PUBLIC_RECEIPT_MERGES,
  PUBLIC_RECEIPT_STATUSES,
  type PublicReceiptStatus,
} from '@gyblos/core/constants';
import type {
  PublicReceipt,
  PublicReceiptEntry,
} from '@gyblos/core/public-receipts';
import {
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  RECEIPT,
} from '@gyblos/protocol/constants';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
} from '@gyblos/protocol/receipt';
import {
  parseBuyerReceiptV2,
  parseSellerReceiptV2,
  RECEIPT_V2,
} from '@gyblos/protocol/receipt-v2';

import {
  COMMIT_RESULTS,
  type CollectorStorage,
  type CollectorWrite,
  type ReceiptWrite,
} from './storage';

export type D1Value = string | number | null;
export type D1Row = Record<string, unknown>;
export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  all(): Promise<{ results: D1Row[] }>;
  run(): Promise<unknown>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

const REPORTED_AT_COLUMN = {
  [P2P_ROLES.SELLER]: 'seller_reported_at',
  [P2P_ROLES.BUYER]: 'buyer_reported_at',
} as const;

function badRow(): never {
  throw new TypeError('Unexpected collector storage row.');
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : badRow();
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : badRow();
}
function status(value: unknown): PublicReceiptStatus {
  for (const item of Object.values(PUBLIC_RECEIPT_STATUSES))
    if (value === item) return item;
  return badRow();
}
function signedHalf<T>(value: unknown, parse: (record: unknown) => T) {
  if (!value || typeof value !== 'object') return badRow();
  return {
    record: parse(Reflect.get(value, 'record')),
    signature: text(Reflect.get(value, 'signature')),
  };
}
// Rows are the collector's own, written after verification; this re-parses them strictly anyway.
function storedReceipt(json: string, version: number): PublicReceipt {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object') return badRow();
  const buyer: unknown = Reflect.get(value, 'buyer');
  const seller: unknown = Reflect.get(value, 'seller');
  if (version === RECEIPT.version) {
    const receipt: PublicReceipt = {
      seller: signedHalf(seller, parseSellerReceipt),
    };
    if (buyer !== undefined)
      receipt.buyer = signedHalf(buyer, parseBuyerReceipt);
    return receipt;
  }
  if (version === RECEIPT_V2.version) {
    const receipt: PublicReceipt = {
      seller: signedHalf(seller, parseSellerReceiptV2),
    };
    if (buyer !== undefined)
      receipt.buyer = signedHalf(buyer, parseBuyerReceiptV2);
    return receipt;
  }
  return badRow();
}
function entryOf(row: D1Row): PublicReceiptEntry {
  const version = integer(row.version);
  const receipt = storedReceipt(text(row.receipt_json), version);
  return {
    key: text(row.receipt_key),
    sellerDigest: text(row.seller_digest),
    buyerDigest: nullableText(row.buyer_digest),
    fingerprint: text(row.fingerprint),
    status: status(row.status),
    version: receipt.seller.record.version,
    paid: integer(row.paid) === 1,
    receipt,
  };
}

function receiptValues(entry: PublicReceiptEntry, now: number): D1Value[] {
  const record = entry.receipt.seller.record;
  const paid =
    record.pricing.kind === OFFER_PRICING_KINDS.PAID ? record.pricing : null;
  const channel = 'channel' in record ? record.channel : null;
  return [
    entry.key,
    record.sellerNodeId,
    record.buyerNodeId,
    record.requestId,
    entry.sellerDigest,
    entry.buyerDigest,
    entry.fingerprint,
    entry.status,
    entry.version,
    entry.paid ? 1 : 0,
    record.owner,
    record.selection.modelId,
    record.selection.variant,
    record.selection.quantization,
    record.reasoning,
    record.engineKind,
    record.streaming ? 1 : 0,
    record.outcome,
    record.usage.inputTokens,
    record.usage.outputTokens,
    record.usage.reasoningTokens,
    record.amountAtomic,
    record.feeAtomic,
    paid?.network ?? null,
    paid?.asset ?? null,
    channel?.channelId ?? null,
    channel?.payer ?? null,
    record.timing.receivedAt,
    record.timing.firstTokenMs,
    record.timing.totalMs,
    JSON.stringify(entry.receipt),
    now,
    now,
  ];
}

const RECEIPT_COLUMNS = `receipt_key, seller_node_id, buyer_node_id, request_id, seller_digest,
  buyer_digest, fingerprint, status, version, paid, owner, model_id, variant, quantization, reasoning,
  engine_kind, streaming, outcome, input_tokens, output_tokens, reasoning_tokens, amount_atomic,
  fee_atomic, network, asset, channel_id, payer, seller_received_at, first_token_ms, total_ms,
  receipt_json, inserted_at, updated_at`;
const RECEIPT_COLUMN_COUNT = RECEIPT_COLUMNS.split(',').length;
// A new key is inserted; an existing one only gains its first buyer half for the same seller record.
// Seller fields never change after the first insert.
const UPSERT_RECEIPT = `INSERT INTO collector_receipts (${RECEIPT_COLUMNS})
  VALUES (${Array.from({ length: RECEIPT_COLUMN_COUNT }, () => '?').join(', ')})
  ON CONFLICT (receipt_key) DO UPDATE SET buyer_digest = excluded.buyer_digest,
    fingerprint = excluded.fingerprint, status = excluded.status,
    receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
  WHERE collector_receipts.buyer_digest IS NULL
    AND excluded.buyer_digest IS NOT NULL
    AND collector_receipts.seller_digest = excluded.seller_digest`;
// History only when this write is what is now stored (inserted or upgraded at this instant).
const RECORD_HISTORY = `INSERT OR IGNORE INTO collector_status_history (receipt_key, status, changed_at)
  SELECT receipt_key, status, ? FROM collector_receipts
  WHERE receipt_key = ? AND fingerprint = ? AND updated_at = ?`;
// Evidence against the side that signed something different from the stored first version.
const RECORD_CONFLICT = `INSERT OR IGNORE INTO collector_conflicts
  (envelope_id, receipt_key, merge, fingerprint, receipt_json, inserted_at)
  SELECT ?, receipt_key, CASE WHEN seller_digest <> ? THEN ? ELSE ? END, ?, ?, ?
  FROM collector_receipts
  WHERE receipt_key = ? AND (seller_digest <> ?
    OR (? IS NOT NULL AND buyer_digest IS NOT NULL AND buyer_digest <> ?))`;

function receiptStatements(
  database: D1Database,
  envelopeId: string,
  { role, incoming }: ReceiptWrite,
  now: number,
): D1PreparedStatement[] {
  const column = REPORTED_AT_COLUMN[role];
  return [
    database
      .prepare(RECORD_CONFLICT)
      .bind(
        envelopeId,
        incoming.sellerDigest,
        PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT,
        PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT,
        incoming.fingerprint,
        JSON.stringify(incoming.receipt),
        now,
        incoming.key,
        incoming.sellerDigest,
        incoming.buyerDigest,
        incoming.buyerDigest,
      ),
    database.prepare(UPSERT_RECEIPT).bind(...receiptValues(incoming, now)),
    database
      .prepare(RECORD_HISTORY)
      .bind(now, incoming.key, incoming.fingerprint, now),
    database
      .prepare(
        `UPDATE collector_receipts SET ${column} = COALESCE(${column}, ?) WHERE receipt_key = ?`,
      )
      .bind(now, incoming.key),
  ];
}

function commitStatements(
  database: D1Database,
  write: CollectorWrite,
  now: number,
): D1PreparedStatement[] {
  const { envelope } = write;
  const upload = envelope.upload;
  return [
    database
      .prepare(
        `INSERT INTO collector_envelopes (id, uploader_node_id, role, client_kind, app_version,
          platform, arch, nonce, sent_at, received_at, skew_ms, item_count, signature, signed_json,
          inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.id,
        upload.uploaderNodeId,
        upload.role,
        upload.client.kind,
        upload.client.appVersion,
        upload.client.platform,
        upload.client.arch,
        upload.nonce,
        upload.sentAt,
        envelope.receivedAt,
        envelope.receivedAt - upload.sentAt,
        upload.items.length,
        envelope.signature,
        envelope.json,
        now,
      ),
    ...write.reports.map((report) =>
      database
        .prepare(
          `INSERT INTO collector_reports (envelope_id, receipt_key, role, fingerprint, merge,
            stored_at, started_at, offer_json, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          report.envelopeId,
          report.key,
          report.role,
          report.fingerprint,
          report.merge,
          report.storedAt,
          report.startedAt,
          report.offerJson,
          now,
        ),
    ),
    ...write.receipts.flatMap((item) =>
      receiptStatements(database, envelope.id, item, now),
    ),
  ];
}

export function createD1Storage(database: D1Database): CollectorStorage {
  return {
    async readEntries(keys) {
      const found = new Map<string, PublicReceiptEntry>();
      if (!keys.length) return found;
      const { results } = await database
        .prepare(
          `SELECT receipt_key, seller_digest, buyer_digest, fingerprint, status, version, paid, receipt_json
           FROM collector_receipts WHERE receipt_key IN (${keys.map(() => '?').join(', ')})`,
        )
        .bind(...keys)
        .all();
      for (const row of results) {
        const entry = entryOf(row);
        found.set(entry.key, entry);
      }
      return found;
    },
    async commit(write, now) {
      const upload = write.envelope.upload;
      try {
        await database.batch(commitStatements(database, write, now));
        return COMMIT_RESULTS.COMMITTED;
      } catch (error) {
        // The batch is one transaction: on a unique violation nothing was written.
        const { results } = await database
          .prepare(
            'SELECT 1 AS found FROM collector_envelopes WHERE uploader_node_id = ? AND nonce = ?',
          )
          .bind(upload.uploaderNodeId, upload.nonce)
          .all();
        if (results.length) return COMMIT_RESULTS.REPLAYED;
        throw error;
      }
    },
  };
}
