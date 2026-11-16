// Public collector policy over receipts whose node signatures were already verified: classification,
// identity and how a new report combines with a stored one. No storage, clock or I/O.
import { canonicalJson } from '@gyblos/protocol';
import {
  OFFER_PRICING_KINDS,
  RECEIPT,
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { sellerReceiptDigest, type ReceiptV1 } from '@gyblos/protocol/receipt';
import {
  sellerReceiptDigestV2,
  type ReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import {
  PUBLIC_RECEIPT_MERGES,
  PUBLIC_RECEIPT_STATUSES,
  RECEIPT_COLLECTOR_CODES,
  RECEIPT_COLLECTOR_FINGERPRINT_RADIX,
  type PublicReceiptMerge,
  type PublicReceiptStatus,
} from './constants';
import { collectorFail } from './receipt-collector-errors';

export type PublicReceipt = ReceiptV1 | ReceiptV2;
export interface PublicReceiptEntry {
  // Canonical [sellerNodeId, buyerNodeId, requestId]; a changed request digest conflicts.
  key: string;
  // SHA-256 hex of the seller's signed record bytes under its version's domain.
  sellerDigest: string;
  // SHA-256 hex of the canonical receipt (both halves when present).
  fingerprint: string;
  status: PublicReceiptStatus;
  version: PublicReceipt['seller']['record']['version'];
  paid: boolean;
  receipt: PublicReceipt;
}
export interface PublicReceiptMergeResult {
  merge: PublicReceiptMerge;
  entry: PublicReceiptEntry;
}

async function sha256Hex(text: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return Array.from(digest, (byte) =>
    byte.toString(RECEIPT_COLLECTOR_FINGERPRINT_RADIX).padStart(2, '0'),
  ).join('');
}

function sellerDigestOf(receipt: PublicReceipt) {
  return receipt.seller.record.version === RECEIPT.version
    ? sellerReceiptDigest(receipt.seller.record)
    : sellerReceiptDigestV2(receipt.seller.record);
}

// The buyer's disputed fields must be exactly the fields where its own observation differs from
// the seller's signed count; a buyer cannot agree while observing something else, or the reverse.
function statusOf(receipt: PublicReceipt): PublicReceiptStatus {
  if (!receipt.buyer) return PUBLIC_RECEIPT_STATUSES.SELLER_ONLY;
  const seller = receipt.seller.record;
  const buyer = receipt.buyer.record;
  const expected = Object.values(RECEIPT_DISPUTE_FIELDS).filter((field) => {
    const reported =
      field === RECEIPT_DISPUTE_FIELDS.OUTPUT_BYTES
        ? seller.sizes.outputBytes
        : seller.usage[field];
    return buyer.observed[field] !== null && buyer.observed[field] !== reported;
  });
  if (canonicalJson(expected) !== canonicalJson(buyer.disputed))
    return collectorFail(RECEIPT_COLLECTOR_CODES.DISPUTE);
  return buyer.verdict === RECEIPT_VERDICTS.AGREED
    ? PUBLIC_RECEIPT_STATUSES.BILATERAL
    : PUBLIC_RECEIPT_STATUSES.DISPUTED;
}

// The caller must pass a receipt already verified with its version's contract (node signatures and
// cross-binding); this policy adds no signature work.
export async function classifyPublicReceipt(
  receipt: PublicReceipt,
): Promise<PublicReceiptEntry> {
  const record = receipt.seller.record;
  const status = statusOf(receipt);
  return {
    key: canonicalJson([
      record.sellerNodeId,
      record.buyerNodeId,
      record.requestId,
    ]),
    sellerDigest: await sellerDigestOf(receipt),
    fingerprint: await sha256Hex(canonicalJson(receipt)),
    status,
    version: record.version,
    paid: record.pricing.kind === OFFER_PRICING_KINDS.PAID,
    receipt,
  };
}

// The first accepted seller record and the first accepted buyer attestation are immutable: any
// different one under the same key is a conflict, kept by the caller and excluded from totals.
export function mergePublicReceipt(
  existing: PublicReceiptEntry | null,
  incoming: PublicReceiptEntry,
): PublicReceiptMergeResult {
  if (!existing)
    return { merge: PUBLIC_RECEIPT_MERGES.INSERT, entry: incoming };
  if (existing.key !== incoming.key)
    return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
  if (existing.fingerprint === incoming.fingerprint)
    return { merge: PUBLIC_RECEIPT_MERGES.IDENTICAL, entry: existing };
  if (existing.sellerDigest !== incoming.sellerDigest)
    return { merge: PUBLIC_RECEIPT_MERGES.CONFLICT, entry: existing };
  if (!incoming.receipt.buyer)
    return { merge: PUBLIC_RECEIPT_MERGES.IDENTICAL, entry: existing };
  if (!existing.receipt.buyer)
    return { merge: PUBLIC_RECEIPT_MERGES.UPGRADE, entry: incoming };
  return { merge: PUBLIC_RECEIPT_MERGES.CONFLICT, entry: existing };
}
