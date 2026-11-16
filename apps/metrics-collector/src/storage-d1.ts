// Owns the D1 storage adapter: one typed read per upload and one transactional batch of set-based,
// chunked writes. First versions, status history and conflicts are decided in SQL against the stored
// row at write time, so concurrent uploads can neither replace a first version nor lose a conflict.
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import {
  PUBLIC_RECEIPT_MERGES,
  PUBLIC_RECEIPT_STATUSES,
  type PublicReceiptMerge,
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

import { COLLECTOR_LIMITS } from './constants';
import {
  createD1Orm,
  type CollectorDatabase,
  type D1Database,
} from './d1-client';
import {
  conflicts,
  envelopes,
  receipts,
  reports,
  statusHistory,
} from './schema';
import {
  COMMIT_RESULTS,
  type CollectorStorage,
  type CollectorWrite,
} from './storage';

export type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Row,
  D1Value,
} from './d1-client';

type ReceiptRow = typeof receipts.$inferInsert;
type ReportInsert = typeof reports.$inferInsert;

// Splits rows so no statement exceeds D1's bound-parameter limit.
function chunks<T>(rows: readonly T[], columns: number): T[][] {
  const size = Math.max(
    1,
    Math.floor(COLLECTOR_LIMITS.maxBoundParameters / columns),
  );
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    result.push(rows.slice(start, start + size));
  return result;
}
const columnCount = (row: object) => Object.keys(row).length;

function badRow(): never {
  throw new TypeError('Unexpected collector storage row.');
}
function status(value: string): PublicReceiptStatus {
  for (const item of Object.values(PUBLIC_RECEIPT_STATUSES))
    if (value === item) return item;
  return badRow();
}
function signedHalf<T>(value: unknown, parse: (record: unknown) => T) {
  if (!value || typeof value !== 'object') return badRow();
  const signature: unknown = Reflect.get(value, 'signature');
  return {
    record: parse(Reflect.get(value, 'record')),
    signature: typeof signature === 'string' ? signature : badRow(),
  };
}
// Rows are the collector's own, written after verification; they are still re-parsed strictly.
function storedReceipt(json: string, version: number): PublicReceipt {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object') return badRow();
  const seller: unknown = Reflect.get(value, 'seller');
  const buyer: unknown = Reflect.get(value, 'buyer');
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

function receiptRow(entry: PublicReceiptEntry, now: number): ReceiptRow {
  const record = entry.receipt.seller.record;
  const paid =
    record.pricing.kind === OFFER_PRICING_KINDS.PAID ? record.pricing : null;
  const channel = 'channel' in record ? record.channel : null;
  return {
    receiptKey: entry.key,
    sellerNodeId: record.sellerNodeId,
    buyerNodeId: record.buyerNodeId,
    requestId: record.requestId,
    sellerDigest: entry.sellerDigest,
    buyerDigest: entry.buyerDigest,
    fingerprint: entry.fingerprint,
    status: entry.status,
    version: entry.version,
    paid: entry.paid ? 1 : 0,
    owner: record.owner,
    modelId: record.selection.modelId,
    variant: record.selection.variant,
    quantization: record.selection.quantization,
    reasoning: record.reasoning,
    engineKind: record.engineKind,
    streaming: record.streaming ? 1 : 0,
    outcome: record.outcome,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    reasoningTokens: record.usage.reasoningTokens,
    amountAtomic: record.amountAtomic,
    feeAtomic: record.feeAtomic,
    network: paid?.network ?? null,
    asset: paid?.asset ?? null,
    channelId: channel?.channelId ?? null,
    payer: channel?.payer ?? null,
    sellerReceivedAt: record.timing.receivedAt,
    firstTokenMs: record.timing.firstTokenMs,
    totalMs: record.timing.totalMs,
    receiptJson: JSON.stringify(entry.receipt),
    // seller_reported_at and buyer_reported_at start NULL and are set by the first-report statement.
    insertedAt: now,
    updatedAt: now,
  };
}

function envelopeInsert(
  database: CollectorDatabase,
  envelope: CollectorWrite['envelope'],
  now: number,
) {
  const { upload } = envelope;
  return database.insert(envelopes).values({
    id: envelope.id,
    uploaderNodeId: upload.uploaderNodeId,
    role: upload.role,
    clientKind: upload.client.kind,
    appVersion: upload.client.appVersion,
    platform: upload.client.platform,
    arch: upload.client.arch,
    nonce: upload.nonce,
    sentAt: upload.sentAt,
    receivedAt: envelope.receivedAt,
    skewMs: envelope.receivedAt - upload.sentAt,
    itemCount: upload.items.length,
    signature: envelope.signature,
    signedJson: envelope.json,
    insertedAt: now,
  });
}

function reportInserts(
  database: CollectorDatabase,
  write: CollectorWrite,
  now: number,
) {
  const rows: ReportInsert[] = write.reports.map((report) => ({
    envelopeId: report.envelopeId,
    receiptKey: report.key,
    role: report.role,
    fingerprint: report.fingerprint,
    sellerDigest: report.sellerDigest,
    buyerDigest: report.buyerDigest,
    merge: report.merge,
    storedAt: report.storedAt,
    startedAt: report.startedAt,
    offerJson: report.offerJson,
    insertedAt: now,
  }));
  return chunks(rows, columnCount(rows[0] ?? {})).map((chunk) =>
    database.insert(reports).values(chunk),
  );
}

// Conflicts against the row as stored before this write, set-based over this envelope's reports.
function conflictInsert(
  database: CollectorDatabase,
  envelopeId: string,
  now: number,
) {
  const differentSeller = ne(receipts.sellerDigest, reports.sellerDigest);
  const differentBuyer = and(
    isNotNull(reports.buyerDigest),
    isNotNull(receipts.buyerDigest),
    ne(receipts.buyerDigest, reports.buyerDigest),
  );
  return database
    .insert(conflicts)
    .select(
      database
        .select({
          envelopeId: reports.envelopeId,
          receiptKey: reports.receiptKey,
          merge:
            sql<PublicReceiptMerge>`case when ${differentSeller} then ${PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT} else ${PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT} end`.as(
              'merge',
            ),
          fingerprint: reports.fingerprint,
          insertedAt: sql<number>`${now}`.as('inserted_at'),
        })
        .from(reports)
        .innerJoin(receipts, eq(receipts.receiptKey, reports.receiptKey))
        .where(
          and(
            eq(reports.envelopeId, envelopeId),
            or(differentSeller, differentBuyer),
          ),
        ),
    )
    .onConflictDoNothing();
}

// New keys are inserted; an existing one only gains its first buyer half for the same seller record.
function receiptUpserts(
  database: CollectorDatabase,
  write: CollectorWrite,
  now: number,
) {
  const rows = write.receipts.map(({ incoming }) => receiptRow(incoming, now));
  return chunks(rows, columnCount(rows[0] ?? {})).map((chunk) =>
    database
      .insert(receipts)
      .values(chunk)
      .onConflictDoUpdate({
        target: receipts.receiptKey,
        set: {
          buyerDigest: sql`excluded.buyer_digest`,
          fingerprint: sql`excluded.fingerprint`,
          status: sql`excluded.status`,
          receiptJson: sql`excluded.receipt_json`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: and(
          isNull(receipts.buyerDigest),
          sql`excluded.buyer_digest is not null`,
          sql`${receipts.sellerDigest} = excluded.seller_digest`,
        ),
      }),
  );
}

// History only where this write is what is now stored (inserted or upgraded at this instant).
function historyInsert(
  database: CollectorDatabase,
  envelopeId: string,
  now: number,
) {
  return database
    .insert(statusHistory)
    .select(
      database
        .select({
          receiptKey: receipts.receiptKey,
          status: receipts.status,
          changedAt: sql<number>`${now}`.as('changed_at'),
        })
        .from(receipts)
        .innerJoin(reports, eq(reports.receiptKey, receipts.receiptKey))
        .where(
          and(
            eq(reports.envelopeId, envelopeId),
            eq(receipts.fingerprint, reports.fingerprint),
            eq(receipts.updatedAt, now),
          ),
        ),
    )
    .onConflictDoNothing();
}

// First report time for the uploader's side, for every key in this envelope.
function firstReportUpdate(
  database: CollectorDatabase,
  write: CollectorWrite,
  now: number,
) {
  const reportedAt =
    write.envelope.upload.role === P2P_ROLES.SELLER
      ? {
          sellerReportedAt: sql`coalesce(${receipts.sellerReportedAt}, ${now})`,
        }
      : { buyerReportedAt: sql`coalesce(${receipts.buyerReportedAt}, ${now})` };
  return database
    .update(receipts)
    .set(reportedAt)
    .where(
      inArray(
        receipts.receiptKey,
        database
          .select({ receiptKey: reports.receiptKey })
          .from(reports)
          .where(eq(reports.envelopeId, write.envelope.id)),
      ),
    );
}

// Order matters: the envelope first (its unique nonce aborts a replay), conflicts before the upsert
// (they compare with the row as stored), history and first report times after it.
function writeStatements(
  database: CollectorDatabase,
  write: CollectorWrite,
  now: number,
) {
  return [
    envelopeInsert(database, write.envelope, now),
    ...reportInserts(database, write, now),
    conflictInsert(database, write.envelope.id, now),
    ...receiptUpserts(database, write, now),
    historyInsert(database, write.envelope.id, now),
    firstReportUpdate(database, write, now),
  ] as const;
}

export function createD1Storage(database: D1Database): CollectorStorage {
  const orm = createD1Orm(database);
  return {
    async readEntries(keys) {
      const found = new Map<string, PublicReceiptEntry>();
      if (!keys.length) return found;
      const rows = await orm
        .select({
          receiptKey: receipts.receiptKey,
          sellerDigest: receipts.sellerDigest,
          buyerDigest: receipts.buyerDigest,
          fingerprint: receipts.fingerprint,
          status: receipts.status,
          version: receipts.version,
          paid: receipts.paid,
          receiptJson: receipts.receiptJson,
        })
        .from(receipts)
        .where(inArray(receipts.receiptKey, [...keys]));
      for (const row of rows) {
        const receipt = storedReceipt(row.receiptJson, row.version);
        found.set(row.receiptKey, {
          key: row.receiptKey,
          sellerDigest: row.sellerDigest,
          buyerDigest: row.buyerDigest,
          fingerprint: row.fingerprint,
          status: status(row.status),
          version: receipt.seller.record.version,
          paid: row.paid === 1,
          receipt,
        });
      }
      return found;
    },
    async commit(write, now) {
      const { upload } = write.envelope;
      try {
        const [first, ...rest] = writeStatements(orm, write, now);
        await orm.batch([first, ...rest]);
        return COMMIT_RESULTS.COMMITTED;
      } catch (error) {
        // The batch is one transaction: on a unique violation nothing was written.
        const replayed = await orm
          .select({ id: envelopes.id })
          .from(envelopes)
          .where(
            and(
              eq(envelopes.uploaderNodeId, upload.uploaderNodeId),
              eq(envelopes.nonce, upload.nonce),
            ),
          );
        if (replayed.length) return COMMIT_RESULTS.REPLAYED;
        throw error;
      }
    },
  };
}
