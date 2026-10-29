// Exercises receipt exchange boundaries using synthetic keys and an injected memory store only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFreeBuyerReceipt } from '@gyblos/core/receipts';
import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
} from '@gyblos/protocol/constants';
import type { ReceiptV1 } from '@gyblos/protocol/receipt';
import {
  parseReceiptChannelRequest,
  parseReceiptChannelResponse,
} from '@gyblos/protocol/receipt-channel';
import { createReceiptService } from '@gyblos/transport-iroh/receipt-service';

import { receiptChannelFixture } from './support/receipt-channel';
import { buyerRecord, receiptSigner } from './support/receipt-fixture';

void test('receipt channel strict request and response grammars reject unknown fields and versions', async () => {
  const f = await receiptChannelFixture();
  assert.deepEqual(parseReceiptChannelRequest(f.get), f.get);
  assert.throws(
    () => parseReceiptChannelRequest({ ...f.get, prompt: 'synthetic' }),
    { code: RECEIPT_CHANNEL_CODES.INVALID },
  );
  assert.throws(() => parseReceiptChannelRequest({ ...f.get, version: 2 }), {
    code: RECEIPT_CHANNEL_CODES.VERSION,
  });
  assert.throws(
    () =>
      parseReceiptChannelResponse({
        version: 1,
        requestId: f.get.requestId,
        result: { receipt: f.envelope },
        error: { code: RECEIPT_CHANNEL_CODES.INTERNAL },
      }),
    { code: RECEIPT_CHANNEL_CODES.INVALID },
  );
});
void test('authenticated buyer fetches seller receipt and confirms signed pair without inference', async () => {
  const f = await receiptChannelFixture();
  const signal = new AbortController().signal;
  assert.deepEqual(await f.service.respond(f.get, f.buyer.nodeId, signal), {
    version: 1,
    requestId: f.get.requestId,
    result: { receipt: f.envelope },
  });
  const response = await f.service.respond(f.confirm, f.buyer.nodeId, signal);
  assert.deepEqual(response, {
    version: 1,
    requestId: f.confirm.requestId,
    result: { receipt: f.confirm.params.receipt },
  });
  assert.equal(f.store.calls, 1);
});
void test('another authenticated NodeId cannot retrieve or confirm a buyer receipt', async () => {
  const f = await receiptChannelFixture();
  const peer = receiptSigner().nodeId;
  const signal = new AbortController().signal;
  const missing = await f.service.respond(f.get, peer, signal);
  assert.ok(missing && typeof missing === 'object' && 'error' in missing);
  assert.deepEqual(missing.error, { code: RECEIPT_CHANNEL_CODES.NOT_FOUND });
  const denied = await f.service.respond(f.confirm, peer, signal);
  assert.ok(denied && typeof denied === 'object' && 'error' in denied);
  assert.deepEqual(denied.error, { code: RECEIPT_CHANNEL_CODES.BINDING });
  assert.equal(f.store.calls, 0);
});
void test('confirmation is idempotent but rejects a different buyer observation', async () => {
  const f = await receiptChannelFixture();
  const signal = new AbortController().signal;
  await f.service.respond(f.confirm, f.buyer.nodeId, signal);
  await f.service.respond(f.confirm, f.buyer.nodeId, signal);
  assert.equal(f.store.calls, 1);
  const receipt = await createFreeBuyerReceipt(
    {
      seller: f.envelope.seller,
      context: f.context,
      observed: {
        ...buyerRecord(f.record, f.record.requestDigest).observed,
        outputTokens: 6,
      },
    },
    f.buyer.sign,
  );
  const conflict = await f.service.respond(
    { ...f.confirm, params: { receipt } },
    f.buyer.nodeId,
    signal,
  );
  assert.ok(conflict && typeof conflict === 'object' && 'error' in conflict);
  assert.deepEqual(conflict.error, { code: RECEIPT_CHANNEL_CODES.CONFLICT });
  assert.equal(f.store.calls, 1);
});
void test('aborted exchange never reaches the store', async () => {
  const f = await receiptChannelFixture();
  let loads = 0;
  const service = createReceiptService({
    nodeId: f.seller.nodeId,
    store: {
      async load() {
        loads++;
        return f.envelope;
      },
      async confirm() {
        assert.fail('aborted confirmation');
      },
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.respond(f.get, f.buyer.nodeId, controller.signal),
    { code: RECEIPT_CHANNEL_CODES.CANCELLED },
  );
  assert.equal(loads, 0);
});

void test('receipt store callback failures return static errors without private messages', async () => {
  const f = await receiptChannelFixture();
  const service = createReceiptService({
    nodeId: f.seller.nodeId,
    store: {
      async load() {
        throw new Error('synthetic-private-store-fault');
      },
      async confirm() {
        assert.fail('unexpected confirmation');
      },
    },
  });
  const response = await service.respond(
    f.get,
    f.buyer.nodeId,
    new AbortController().signal,
  );
  assert.deepEqual(response.error, { code: RECEIPT_CHANNEL_CODES.INTERNAL });
  assert.equal(
    JSON.stringify(response).includes('synthetic-private-store-fault'),
    false,
  );
});
void test('concurrent conflicting confirmations rely on atomic store compare-and-set', async () => {
  const f = await receiptChannelFixture();
  let stored: ReceiptV1 = f.envelope;
  const service = createReceiptService({
    nodeId: f.seller.nodeId,
    store: {
      async load() {
        return stored;
      },
      async confirm(receipt) {
        if (stored.buyer) return false;
        stored = receipt;
        return true;
      },
    },
  });
  const receipt = await createFreeBuyerReceipt(
    {
      seller: f.envelope.seller,
      context: f.context,
      observed: {
        ...f.confirm.params.receipt.buyer.record.observed,
        outputTokens: 6,
      },
    },
    f.buyer.sign,
  );
  const responses = await Promise.all([
    service.respond(f.confirm, f.buyer.nodeId, new AbortController().signal),
    service.respond(
      { ...f.confirm, params: { receipt } },
      f.buyer.nodeId,
      new AbortController().signal,
    ),
  ]);
  assert.equal(responses.filter((r) => r.result).length, 1);
  assert.equal(
    responses.filter((r) => r.error?.code === RECEIPT_CHANNEL_CODES.CONFLICT)
      .length,
    1,
  );
});

void test('cancellation during receipt lookup cannot commit a later confirmation', async () => {
  const f = await receiptChannelFixture();
  let resolve: (value: ReceiptV1) => void = () => {};
  let writes = 0;
  const service = createReceiptService({
    nodeId: f.seller.nodeId,
    store: {
      load: () =>
        new Promise<ReceiptV1>((r) => {
          resolve = r;
        }),
      async confirm() {
        writes++;
        return true;
      },
    },
  });
  const controller = new AbortController();
  const pending = service.respond(f.confirm, f.buyer.nodeId, controller.signal);
  controller.abort();
  resolve(f.envelope);
  await assert.rejects(pending, { code: RECEIPT_CHANNEL_CODES.CANCELLED });
  assert.equal(writes, 0);
});
