// Synthetic receipt store and signers for exchange contracts; no disk or runtime inference.
import assert from 'node:assert/strict';

import { createFreeBuyerReceipt } from '@gyblos/core/receipts';
import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import { signSellerReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';
import type { Signer } from '@gyblos/protocol/signing';
import { createReceiptService } from '@gyblos/transport-iroh/receipt-service';

import { buyerRecord, receiptSigner, sellerRecord } from './receipt-fixture';

export async function receiptChannelFixture(
  seller: { nodeId: string; sign: Signer } = receiptSigner(),
  buyer: { nodeId: string; sign: Signer } = receiptSigner(),
) {
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const envelope = { seller: await signSellerReceipt(record, seller.sign) };
  const store: { value: ReceiptV1; calls: number } = {
    value: envelope,
    calls: 0,
  };
  const service = createReceiptService({
    nodeId: seller.nodeId,
    store: {
      async load() {
        return store.value;
      },
      async confirm(value: ReceiptV1) {
        store.calls++;
        store.value = value;
        return true;
      },
    },
  });
  const get = {
    version: RECEIPT_CHANNEL.version,
    requestId: 'aa'.repeat(16),
    method: RECEIPT_CHANNEL_METHODS.GET,
    params: {
      executionRequestId: record.requestId,
      requestDigest: record.requestDigest,
    },
  };
  const context = {
    requestId: record.requestId,
    requestDigest: record.requestDigest,
    sellerNodeId: record.sellerNodeId,
    buyerNodeId: record.buyerNodeId,
    owner: record.owner,
    selection: record.selection,
    reasoning: record.reasoning,
    streaming: record.streaming,
  };
  const receipt = await createFreeBuyerReceipt(
    {
      seller: envelope.seller,
      context,
      observed: buyerRecord(record, record.requestDigest).observed,
    },
    buyer.sign,
  );
  assert.ok(receipt.buyer);
  const confirm = {
    version: RECEIPT_CHANNEL.version,
    requestId: 'bb'.repeat(16),
    method: RECEIPT_CHANNEL_METHODS.CONFIRM,
    params: { receipt: { ...receipt, buyer: receipt.buyer } },
  };
  return {
    seller,
    buyer,
    record,
    envelope,
    store,
    service,
    get,
    confirm,
    context,
  };
}
