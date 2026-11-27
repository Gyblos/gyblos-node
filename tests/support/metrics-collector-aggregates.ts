// Raw collector rows for aggregate tests: complete synthetic receipts, envelopes and observations
// written straight into the node:sqlite D1, so each formula is checked against known inputs.
import { createHash } from 'node:crypto';

import type { SqliteD1 } from './metrics-collector-d1';

export const DAY = '2026-11-16';
export const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
export const HOUR = 3_600_000;
export const NOW = DAY_START + 30 * HOUR;
export const SELLER_A = 'a1'.repeat(32);
export const SELLER_B = 'b2'.repeat(32);

let sequence = 0;
const hex = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ReceiptFixture {
  seller?: string;
  buyer?: string;
  status?: 'bilateral' | 'seller-only' | 'disputed';
  paid?: boolean;
  payer?: string | null;
  model?: string;
  variant?: string | null;
  outcome?: 'completed' | 'failed' | 'cancelled';
  receivedAt?: number;
  updatedAt?: number;
  firstTokenMs?: number | null;
  totalMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number | null;
  amountAtomic?: string;
  feeAtomic?: string;
  requestId?: string;
}

export function insertReceipt(
  database: SqliteD1,
  fixture: ReceiptFixture = {},
) {
  const key = hex(`receipt-${++sequence}`);
  const receivedAt = fixture.receivedAt ?? DAY_START + HOUR;
  database.raw
    .prepare(
      `INSERT INTO collector_receipts (receipt_key, seller_node_id, buyer_node_id, request_id,
        seller_digest, buyer_digest, fingerprint, status, version, paid, owner, model_id, variant,
        quantization, reasoning, engine_kind, streaming, outcome, input_tokens, output_tokens,
        reasoning_tokens, amount_atomic, fee_atomic, network, asset, channel_id, payer,
        seller_received_at, first_token_ms, total_ms, receipt_json, seller_reported_at,
        buyer_reported_at, inserted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', ?, ?, NULL, 'off', 'ollama', 1, ?, ?, ?, ?, ?, ?,
        NULL, NULL, NULL, ?, ?, ?, ?, '{}', ?, NULL, ?, ?)`,
    )
    .run(
      key,
      fixture.seller ?? SELLER_A,
      fixture.buyer ?? 'c3'.repeat(32),
      fixture.requestId ?? hex(`request-${sequence}`).slice(0, 32),
      hex(`seller-${sequence}`),
      fixture.status === 'seller-only' ? null : hex(`buyer-${sequence}`),
      hex(`fingerprint-${sequence}`),
      fixture.status ?? 'bilateral',
      fixture.paid ? 1 : 0,
      fixture.model ?? 'synthetic/model',
      fixture.variant ?? null,
      fixture.outcome ?? 'completed',
      fixture.inputTokens ?? 10,
      fixture.outputTokens ?? 20,
      fixture.reasoningTokens === undefined ? 0 : fixture.reasoningTokens,
      fixture.amountAtomic ?? '0',
      fixture.feeAtomic ?? '0',
      fixture.payer ?? null,
      receivedAt,
      fixture.firstTokenMs === undefined ? 150 : fixture.firstTokenMs,
      fixture.totalMs ?? 900,
      receivedAt,
      receivedAt,
      fixture.updatedAt ?? receivedAt,
    );
  return key;
}

export function insertConflict(
  database: SqliteD1,
  receiptKey: string,
  at: number,
) {
  database.raw
    .prepare(
      `INSERT INTO collector_conflicts (envelope_id, receipt_key, merge, fingerprint, inserted_at)
       VALUES (?, ?, 'buyer-conflict', ?, ?)`,
    )
    .run(hex(`conflict-${++sequence}`), receiptKey, hex(`f-${sequence}`), at);
}

export function insertEnvelope(
  database: SqliteD1,
  role: 'seller' | 'buyer',
  at: number,
  clientKind = role === 'seller' ? 'seller-node' : 'buyer-desktop',
) {
  const id = hex(`envelope-${++sequence}`);
  database.raw
    .prepare(
      `INSERT INTO collector_envelopes (id, kind, uploader_node_id, role, client_kind, app_version,
        platform, arch, nonce, sent_at, received_at, skew_ms, item_count, signature, signed_json,
        inserted_at)
       VALUES (?, 'observations', ?, ?, ?, '0.1.0-beta.11', 'macos', 'arm64', ?, ?, ?,
        0, 1, 'sig', '{}', ?)`,
    )
    .run(
      id,
      hex(`uploader-${sequence}`),
      role,
      clientKind,
      hex(`nonce-${sequence}`),
      at,
      at,
      at,
    );
  return id;
}

export function insertObservation(
  database: SqliteD1,
  envelopeId: string,
  record: Record<string, unknown> & { type: string; at: number },
  insertedAt = record.at,
) {
  database.raw
    .prepare(
      `INSERT INTO collector_observations (event_key, envelope_id, event_index, type, at, request_id,
        seller_node_id, model_id, record_json, inserted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hex(`event-${++sequence}`),
      envelopeId,
      sequence,
      record.type,
      record.at,
      (record.requestId as string | null | undefined) ?? null,
      (record.sellerNodeId as string | null | undefined) ?? null,
      (record.model as string | undefined) ?? 'synthetic/model',
      JSON.stringify(record),
      insertedAt,
    );
}

// One upload's report of a receipt, as the collector stores it per envelope.
export function insertReport(
  database: SqliteD1,
  envelopeId: string,
  receiptKey: string,
  role: 'seller' | 'buyer',
  insertedAt = 0,
) {
  database.raw
    .prepare(
      `INSERT INTO collector_reports (envelope_id, receipt_key, role, fingerprint, seller_digest,
        buyer_digest, merge, stored_at, started_at, offer_json, inserted_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'new', NULL, NULL, NULL, ?)`,
    )
    .run(
      envelopeId,
      receiptKey,
      role,
      hex(`rf-${++sequence}`),
      hex(`rs-${sequence}`),
      insertedAt,
    );
}
