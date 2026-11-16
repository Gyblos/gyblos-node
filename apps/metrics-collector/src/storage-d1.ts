// Owns the D1 storage port: one transactional batch per upload with guarded upserts, so the first
// accepted seller record and buyer attestation can never be replaced, even by concurrent uploads.
import { PUBLIC_RECEIPT_MERGES } from '@gyblos/core/constants';
import type { PublicReceiptEntry } from '@gyblos/core/public-receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import {
  COMMIT_RESULTS,
  isConflict,
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

function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError('Unexpected collector storage row.');
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Unexpected collector storage row.');
  return value;
}

function entryOf(row: D1Row): PublicReceiptEntry {
  const version = integer(row.version);
  if (version !== 1 && version !== 2)
    throw new TypeError('Unexpected collector storage row.');
  const receipt: unknown = JSON.parse(text(row.receipt_json));
  return {
    key: text(row.receipt_key),
    sellerDigest: text(row.seller_digest),
    buyerDigest: nullableText(row.buyer_digest),
    fingerprint: text(row.fingerprint),
    status: text(row.status) as PublicReceiptEntry['status'],
    version,
    paid: integer(row.paid) === 1,
    receipt: receipt as PublicReceiptEntry['receipt'],
  };
}

function receiptValues(entry: PublicReceiptEntry, now: number): D1Value[] {
  const record = entry.receipt.seller.record;
  const paid = record.pricing.kind === 'paid' ? record.pricing : null;
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
const RECEIPT_PLACEHOLDERS = Array.from({ length: 33 }, () => '?').join(', ');
// A new key is inserted; an existing one only gains its first buyer half for the same seller record.
const UPSERT_RECEIPT = `INSERT INTO collector_receipts (${RECEIPT_COLUMNS}) VALUES (${RECEIPT_PLACEHOLDERS})
  ON CONFLICT (receipt_key) DO UPDATE SET buyer_digest = excluded.buyer_digest,
    fingerprint = excluded.fingerprint, status = excluded.status,
    receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
  WHERE collector_receipts.buyer_digest IS NULL
    AND excluded.buyer_digest IS NOT NULL
    AND collector_receipts.seller_digest = excluded.seller_digest`;

function receiptStatements(
  database: D1Database,
  envelopeId: string,
  item: ReceiptWrite,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (
    item.merge === PUBLIC_RECEIPT_MERGES.INSERT ||
    item.merge === PUBLIC_RECEIPT_MERGES.UPGRADE
  ) {
    statements.push(
      database.prepare(UPSERT_RECEIPT).bind(...receiptValues(item.stored, now)),
      database
        .prepare(
          'INSERT OR IGNORE INTO collector_status_history (receipt_key, status, changed_at) VALUES (?, ?, ?)',
        )
        .bind(item.stored.key, item.stored.status, now),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE collector_receipts SET ${REPORTED_AT_COLUMN[item.role]} = COALESCE(${REPORTED_AT_COLUMN[item.role]}, ?) WHERE receipt_key = ?`,
      )
      .bind(now, item.stored.key),
  );
  if (isConflict(item.merge))
    statements.push(
      database
        .prepare(
          'INSERT OR IGNORE INTO collector_conflicts (envelope_id, receipt_key, merge, fingerprint, receipt_json, inserted_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          envelopeId,
          item.incoming.key,
          item.merge,
          item.incoming.fingerprint,
          JSON.stringify(item.incoming.receipt),
          now,
        ),
    );
  return statements;
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
    async commit(write: CollectorWrite, now: number) {
      const upload = write.envelope.upload;
      const statements = commitStatements(database, write, now);
      try {
        await database.batch(statements);
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
