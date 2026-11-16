// Synthetic quotes and versioned upload claims; no private product keys or persisted conversations.
import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  RECEIPT_UPLOAD_V2,
  type ReceiptUploadV2,
} from '@gyblos/protocol/receipt-upload-v2';

import { controlFixture } from './control-fixture';
import { buyerUpload, paidPair } from './receipt-upload';

export async function quoteRecord() {
  const source = await controlFixture();
  const signed = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  return signed.offer;
}

export async function referencedUpload() {
  const pair = await paidPair();
  const legacy = buyerUpload(pair.buyer.nodeId, pair.receipt);
  const upload: ReceiptUploadV2 = {
    ...legacy,
    version: RECEIPT_UPLOAD_V2.version,
    items: legacy.items.map((item) => ({
      ...item,
      // This is deliberately a declared reference; the upload does not authenticate a quote.
      offer: item.offer && { ...item.offer, offerDigest: '34'.repeat(32) },
    })),
  };
  return { ...pair, upload };
}
