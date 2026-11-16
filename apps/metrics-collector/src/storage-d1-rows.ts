// Owns the mapping between public receipt entries and collector_receipts rows: building insert rows
// and strictly re-parsing stored rows. No queries or I/O.
import {
  PUBLIC_RECEIPT_STATUSES,
  type PublicReceiptStatus,
} from '@gyblos/core/constants';
import type {
  PublicReceipt,
  PublicReceiptEntry,
} from '@gyblos/core/public-receipts';
import { OFFER_PRICING_KINDS, RECEIPT } from '@gyblos/protocol/constants';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
} from '@gyblos/protocol/receipt';
import {
  parseBuyerReceiptV2,
  parseSellerReceiptV2,
  RECEIPT_V2,
} from '@gyblos/protocol/receipt-v2';

import type { receipts } from './schema';

type ReceiptRow = typeof receipts.$inferInsert;

function badRow(): never {
  throw new TypeError('Unexpected collector storage row.');
}
export function status(value: string): PublicReceiptStatus {
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
export function storedReceipt(json: string, version: number): PublicReceipt {
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

export function receiptRow(entry: PublicReceiptEntry, now: number): ReceiptRow {
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
