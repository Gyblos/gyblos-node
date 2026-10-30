// Supplies synthetic signed receipt pairs and an atomic in-memory backend for ingestion tests only.
import { canonicalJson } from '@gyblos/protocol';
import { RECEIPT_COLLECTOR_WRITES } from '@gyblos/core/constants';
import type { PrivateFreeReceipt, PrivateReceiptStore } from '@gyblos/core/receipt-collector';
import { signSellerReceipt, signBuyerReceipt, sellerReceiptDigest, type SellerReceiptV1, type BuyerReceiptV1 } from '@gyblos/protocol/receipt';
import type { ConfirmedReceipt } from '@gyblos/protocol/receipt-channel';

import { receiptSigner, sellerRecord, buyerRecord } from './receipt-fixture';

export const receiptBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
export async function collectorPair(
  changeSeller: (value: SellerReceiptV1) => SellerReceiptV1 = (value) => value,
  changeBuyer: (value: BuyerReceiptV1) => BuyerReceiptV1 = (value) => value,
) {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  const record = changeSeller(sellerRecord(seller.nodeId, buyer.nodeId));
  const pair: ConfirmedReceipt = {
    seller: await signSellerReceipt(record, seller.sign),
    buyer: await signBuyerReceipt(changeBuyer(buyerRecord(record, await sellerReceiptDigest(record))), buyer.sign),
  };
  return { pair, seller, buyer };
}
export function collectorStore(capacity = 8) {
  const entries = new Map<string, PrivateFreeReceipt>();
  let calls = 0;
  const store: PrivateReceiptStore = {
    async insert(entry, signal) {
      calls++;
      if (signal?.aborted) throw new Error('Synthetic abort');
      const previous = entries.get(entry.key);
      if (previous) return previous.fingerprint === entry.fingerprint
        ? RECEIPT_COLLECTOR_WRITES.IDENTICAL : RECEIPT_COLLECTOR_WRITES.CONFLICT;
      if (entries.size >= capacity) return RECEIPT_COLLECTOR_WRITES.FULL;
      entries.set(entry.key, structuredClone(entry));
      return RECEIPT_COLLECTOR_WRITES.INSERTED;
    },
  };
  return { store, entries, calls: () => calls };
}
