// Owns the receipt evidence rules shared by receipt building and collection: which fields a buyer's
// observation disputes, the per-execution key and SHA-256 hex. No I/O or clock.
import { canonicalJson } from '@gyblos/protocol';
import {
  RECEIPT_DISPUTE_FIELDS,
  type ReceiptDisputeField,
} from '@gyblos/protocol/constants';
import type { BuyerReceiptV1, SellerReceiptV1 } from '@gyblos/protocol/receipt';

import { RECEIPT_COLLECTOR_FINGERPRINT_RADIX } from './constants';

// Fields where the buyer's own non-null observation differs from the seller's signed count, in the
// canonical dispute order.
export function observedDisputes(
  seller: Pick<SellerReceiptV1, 'usage' | 'sizes'>,
  observed: BuyerReceiptV1['observed'],
): ReceiptDisputeField[] {
  return Object.values(RECEIPT_DISPUTE_FIELDS).filter((field) => {
    const reported =
      field === RECEIPT_DISPUTE_FIELDS.OUTPUT_BYTES
        ? seller.sizes.outputBytes
        : seller.usage[field];
    return observed[field] !== null && observed[field] !== reported;
  });
}

// Canonical [sellerNodeId, buyerNodeId, requestId]; a changed request digest cannot evade a conflict.
export function receiptKey(
  seller: Pick<SellerReceiptV1, 'sellerNodeId' | 'buyerNodeId' | 'requestId'>,
): string {
  return canonicalJson([
    seller.sellerNodeId,
    seller.buyerNodeId,
    seller.requestId,
  ]);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return Array.from(digest, (byte) =>
    byte.toString(RECEIPT_COLLECTOR_FINGERPRINT_RADIX).padStart(2, '0'),
  ).join('');
}
