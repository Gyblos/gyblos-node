// Public collector policy over receipts from either party: verification, classification, identity and
// how a new report combines with a stored one. No storage, clock or I/O.
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_LIMITS,
  OFFER_PRICING_KINDS,
  RECEIPT,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { controlHex, controlObject } from '@gyblos/protocol/control-validation';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
  sellerReceiptDigest,
  verifyReceipt,
  type ReceiptV1,
} from '@gyblos/protocol/receipt';
import {
  sellerReceiptDigestV2,
  verifyReceiptV2,
  type ReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import {
  PUBLIC_RECEIPT_MERGES,
  PUBLIC_RECEIPT_STATUSES,
  RECEIPT_COLLECTOR_CODES,
  type PublicReceiptMerge,
  type PublicReceiptStatus,
} from './constants';
import { collectorFail } from './receipt-collector-errors';
import { observedDisputes, receiptKey, sha256Hex } from './receipt-evidence';

export { ReceiptCollectorError } from './receipt-collector-errors';

export type PublicReceipt = ReceiptV1 | ReceiptV2;
// Only classifyPublicReceipt creates entries; merge trusts their derived fields.
export interface PublicReceiptEntry {
  // Canonical [sellerNodeId, buyerNodeId, requestId]; a changed request digest conflicts.
  key: string;
  // SHA-256 hex of the seller's signed record bytes under its version's domain.
  sellerDigest: string;
  // SHA-256 hex of the canonical buyer record, or null for a seller-only receipt.
  buyerDigest: string | null;
  // SHA-256 hex of the canonical records (signatures excluded).
  fingerprint: string;
  status: PublicReceiptStatus;
  version: PublicReceipt['seller']['record']['version'];
  paid: boolean;
  // The verified, detached receipt; never the caller's object.
  receipt: PublicReceipt;
}
export interface PublicReceiptMergeResult {
  merge: PublicReceiptMerge;
  // The entry to keep stored under the key.
  entry: PublicReceiptEntry;
}

// Verifies node signatures and cross-binding with the receipt's own version contract. The result is a
// detached copy, so later caller mutation changes nothing.
function plainObject(value: unknown) {
  if (!value || typeof value !== 'object')
    return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
  // Validates descriptors before any value is read.
  return controlObject(value, Object.keys(value));
}
function snapshotHalf<T>(value: unknown, parse: (record: unknown) => T) {
  const input = controlObject(value, ['record', 'signature']);
  return {
    record: parse(input.record),
    signature: controlHex(input.signature, CONTROL_LIMITS.signatureBytes),
  };
}
function snapshotV1(value: unknown): ReceiptV1 {
  const hasBuyer =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'buyer');
  const input = controlObject(value, [
    'seller',
    ...(hasBuyer ? ['buyer'] : []),
  ]);
  const receipt: ReceiptV1 = {
    seller: snapshotHalf(input.seller, parseSellerReceipt),
  };
  if (hasBuyer) receipt.buyer = snapshotHalf(input.buyer, parseBuyerReceipt);
  return receipt;
}
function verifyPublicReceipt(value: unknown): Promise<PublicReceipt> {
  const { version } = plainObject(
    plainObject(plainObject(value).seller).record,
  );
  return version === RECEIPT.version
    ? verifyReceipt(snapshotV1(value))
    : verifyReceiptV2(value);
}

function sellerDigestOf(receipt: PublicReceipt) {
  return receipt.seller.record.version === RECEIPT.version
    ? sellerReceiptDigest(receipt.seller.record)
    : sellerReceiptDigestV2(receipt.seller.record);
}

// A buyer's disputed fields must be exactly those where its own observation differs from the seller's
// signed count. A paid buyer half that disputes is accepted here as disputed; the receipt builder
// never produces one, so it can only come from a non-conforming buyer and is kept as evidence.
function statusOf(receipt: PublicReceipt): PublicReceiptStatus {
  if (!receipt.buyer) return PUBLIC_RECEIPT_STATUSES.SELLER_ONLY;
  const buyer = receipt.buyer.record;
  if (
    canonicalJson(observedDisputes(receipt.seller.record, buyer.observed)) !==
    canonicalJson(buyer.disputed)
  )
    return collectorFail(RECEIPT_COLLECTOR_CODES.DISPUTE);
  return buyer.verdict === RECEIPT_VERDICTS.AGREED
    ? PUBLIC_RECEIPT_STATUSES.BILATERAL
    : PUBLIC_RECEIPT_STATUSES.DISPUTED;
}

// Verifies (signature failures surface as protocol ControlError codes) and classifies one receipt.
// Bilateral means two node keys agreed; it does not show that two independent parties exist.
export async function classifyPublicReceipt(
  value: unknown,
): Promise<PublicReceiptEntry> {
  const receipt = await verifyPublicReceipt(value);
  const record = receipt.seller.record;
  const status = statusOf(receipt);
  return {
    key: receiptKey(record),
    sellerDigest: await sellerDigestOf(receipt),
    buyerDigest: receipt.buyer
      ? await sha256Hex(canonicalJson(receipt.buyer.record))
      : null,
    fingerprint: await sha256Hex(
      canonicalJson([record, receipt.buyer?.record ?? null]),
    ),
    status,
    version: record.version,
    paid: record.pricing.kind === OFFER_PRICING_KINDS.PAID,
    receipt,
  };
}

// The first accepted seller record and the first accepted buyer attestation are immutable. A different
// one under the same key is a conflict attributed to the side that signed it; the stored entry stays
// and keeps counting, so a seller cannot erase a buyer's dispute by signing a second record.
export function mergePublicReceipt(
  existing: PublicReceiptEntry | null,
  incoming: PublicReceiptEntry,
): PublicReceiptMergeResult {
  if (!existing)
    return { merge: PUBLIC_RECEIPT_MERGES.INSERT, entry: incoming };
  if (existing.key !== incoming.key)
    return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
  if (existing.sellerDigest !== incoming.sellerDigest)
    return { merge: PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT, entry: existing };
  if (
    incoming.buyerDigest === null ||
    incoming.buyerDigest === existing.buyerDigest
  )
    return { merge: PUBLIC_RECEIPT_MERGES.IDENTICAL, entry: existing };
  if (existing.buyerDigest === null)
    return { merge: PUBLIC_RECEIPT_MERGES.UPGRADE, entry: incoming };
  return { merge: PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT, entry: existing };
}
