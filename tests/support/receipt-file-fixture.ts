// Creates isolated collector stores and synthetic records; no actual node home or key is opened.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { prepareCollectedReceipt } from '@gyblos/core/receipt-collector';
import {
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
} from '@gyblos/protocol/receipt';

import { collectorPair, receiptBytes } from './receipt-collector';

export async function receiptFileFixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-collector-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { pair, seller, buyer } = await collectorPair();
  const entry = await prepareCollectedReceipt(receiptBytes(pair));
  const otherRecord = { ...pair.seller.record, requestId: '66'.repeat(16) };
  const other = await prepareCollectedReceipt(
    receiptBytes({
      seller: await signSellerReceipt(otherRecord, seller.sign),
      buyer: await signBuyerReceipt(
        {
          ...pair.buyer.record,
          requestId: otherRecord.requestId,
          sellerReceiptDigest: await sellerReceiptDigest(otherRecord),
        },
        buyer.sign,
      ),
    }),
  );
  const changedRecord = {
    ...pair.seller.record,
    requestDigest: '77'.repeat(32),
  };
  const conflict = await prepareCollectedReceipt(
    receiptBytes({
      seller: await signSellerReceipt(changedRecord, seller.sign),
      buyer: await signBuyerReceipt(
        {
          ...pair.buyer.record,
          sellerReceiptDigest: await sellerReceiptDigest(changedRecord),
        },
        buyer.sign,
      ),
    }),
  );
  return {
    directory,
    path: join(directory, 'receipts.json'),
    entry,
    other,
    conflict,
  };
}
