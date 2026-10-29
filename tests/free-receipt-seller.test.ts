// Tests seller receipt production with synthetic engines and injected stores; never touches private product state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import {
  createSellerReceiptRuntime,
  type LocalReceiptStore,
} from '@gyblos/node/receipts';
import {
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import { verifyReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';

import { freeSellerFixture } from './support/free-seller';

function memoryStore() {
  let value: ReceiptV1 | undefined;
  let writes = 0;
  const store: LocalReceiptStore = {
    async put(input) {
      writes++;
      value = await verifyReceipt(input);
    },
    async load() {
      return value;
    },
    async confirm() {
      return false;
    },
  };
  return { store, writes: () => writes, value: () => value };
}
void test('successful seller execution signs actual usage once without persisting content', async () => {
  const f = await freeSellerFixture();
  const memory = memoryStore();
  const runtime = createSellerReceiptRuntime({
    nodeId: f.options.nodeId,
    store: memory.store,
    signer: f.source.nodeSigner,
  });
  const service = createSellerFreeExecution({
    ...f.options,
    receipts: { publisher: runtime.publisher, engineKind: ENGINE_KINDS.OLLAMA },
  });
  const request = await f.request();
  try {
    const response = await service.respond(
      request,
      request.quote.offer.buyerNodeId,
      new AbortController().signal,
    );
    assert.ok(response.result);
    await runtime.settled();
    const value = memory.value();
    assert.ok(value);
    assert.deepEqual((await verifyReceipt(value)).seller.record.usage, {
      inputTokens: 4,
      outputTokens: 2,
      reasoningTokens: null,
    });
    assert.equal(value.seller.record.outcome, RECEIPT_OUTCOMES.COMPLETED);
    assert.equal(value.buyer, undefined);
    assert.equal(memory.writes(), 1);
    assert.equal(f.calls(), 1);
    assert.equal(JSON.stringify(value).includes('answer'), false);
    assert.equal(JSON.stringify(value).includes('hello'), false);
  } finally {
    await runtime.close();
  }
});
void test('receipt signing or persistence errors cannot change a successful seller response', async () => {
  for (const badSigner of [false, true]) {
    const f = await freeSellerFixture();
    const store: LocalReceiptStore = {
      async put() {
        throw new Error('synthetic-private-store-fault');
      },
      async load() {
        return undefined;
      },
      async confirm() {
        return false;
      },
    };
    const runtime = createSellerReceiptRuntime({
      nodeId: f.options.nodeId,
      store,
      signer: badSigner
        ? async () => {
            throw new Error('synthetic-private-signer-fault');
          }
        : f.source.nodeSigner,
    });
    const service = createSellerFreeExecution({
      ...f.options,
      receipts: {
        publisher: runtime.publisher,
        engineKind: ENGINE_KINDS.OLLAMA,
      },
    });
    const request = await f.request();
    try {
      assert.ok(
        (
          await service.respond(
            request,
            request.quote.offer.buyerNodeId,
            new AbortController().signal,
          )
        ).result,
      );
      assert.equal(f.calls(), 1);
      await runtime.settled();
      assert.equal(runtime.health().failed, 1);
    } finally {
      await runtime.close();
    }
  }
});
void test('failed recounted execution gets an unconfirmed receipt but provider admission estimates never become usage', async () => {
  for (const declared of [false, true]) {
    const f = await freeSellerFixture(
      { dailyTokenCap: 10000, perBuyerCap: 10000 },
      declared ? { meter: DECLARED_METER } : {},
    );
    const memory = memoryStore();
    const runtime = createSellerReceiptRuntime({
      nodeId: f.options.nodeId,
      store: memory.store,
      signer: f.source.nodeSigner,
    });
    const service = createSellerFreeExecution({
      ...f.options,
      engine: {
        ...f.options.engine,
        generate: async () => {
          throw new Error('synthetic-engine-down');
        },
      },
      receipts: {
        publisher: runtime.publisher,
        engineKind: ENGINE_KINDS.OLLAMA,
      },
    });
    const request = await f.request();
    try {
      const response = await service.respond(
        request,
        request.quote.offer.buyerNodeId,
        new AbortController().signal,
      );
      assert.equal(response.error?.code, FREE_EXECUTION_CODES.ENGINE);
      await runtime.settled();
      if (declared) assert.equal(memory.value(), undefined);
      else {
        const value = memory.value();
        assert.ok(value);
        assert.equal(value.seller.record.outcome, RECEIPT_OUTCOMES.FAILED);
        assert.equal(value.seller.record.usage.outputTokens, 0);
        assert.equal(value.buyer, undefined);
      }
    } finally {
      await runtime.close();
    }
  }
});
void test('busy requests create no receipt', async () => {
  const f = await freeSellerFixture();
  const memory = memoryStore();
  const runtime = createSellerReceiptRuntime({
    nodeId: f.options.nodeId,
    store: memory.store,
    signer: f.source.nodeSigner,
  });
  const request = await f.request();
  f.setBusy(true);
  const service = createSellerFreeExecution({
    ...f.options,
    receipts: { publisher: runtime.publisher, engineKind: ENGINE_KINDS.OLLAMA },
  });
  try {
    assert.equal(
      (
        await service.respond(
          request,
          request.quote.offer.buyerNodeId,
          new AbortController().signal,
        )
      ).error?.code,
      FREE_EXECUTION_CODES.BUSY,
    );
    assert.equal(memory.writes(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    await runtime.close();
  }
});
void test('hung receipt work returns within its budget and does not accumulate more work', async () => {
  const f = await freeSellerFixture();
  let release = () => {};
  let calls = 0;
  const store: LocalReceiptStore = {
    put: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async load() {
      return undefined;
    },
    async confirm() {
      return false;
    },
  };
  const runtime = createSellerReceiptRuntime({
    nodeId: f.options.nodeId,
    store,
    signer: f.source.nodeSigner,
  });
  const service = createSellerFreeExecution({
    ...f.options,
    receipts: { publisher: runtime.publisher, engineKind: ENGINE_KINDS.OLLAMA },
  });
  try {
    const request = await f.request();
    const response = await service.respond(
      request,
      request.quote.offer.buyerNodeId,
      new AbortController().signal,
    );
    assert.ok(response.result);
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    assert.equal(runtime.health().active, true);
    const next = await f.request(2);
    assert.ok(
      (
        await service.respond(
          next,
          next.quote.offer.buyerNodeId,
          new AbortController().signal,
        )
      ).result,
    );
    assert.equal(calls, 1);
    assert.equal(runtime.health().dropped, 1);
    assert.equal(f.calls(), 2);
  } finally {
    release();
    await runtime.settled();
    await runtime.close();
  }
});

void test('receipt clocks cannot turn a successful stream into an engine failure', async () => {
  const f = await freeSellerFixture();
  const memory = memoryStore();
  const runtime = createSellerReceiptRuntime({
    nodeId: f.options.nodeId,
    store: memory.store,
    signer: f.source.nodeSigner,
  });
  let ticks = 0;
  const service = createSellerFreeExecution({
    ...f.options,
    engine: {
      ...f.options.engine,
      generate: async (input) => {
        const result = await f.options.engine.generate(input);
        await input.onText?.(result.text);
        return result;
      },
    },
    receipts: {
      publisher: runtime.publisher,
      engineKind: ENGINE_KINDS.OLLAMA,
      clock: () => {
        if (ticks++ === 0) return 0;
        throw new Error('synthetic-clock-fault');
      },
    },
  });
  const request = await f.request();
  try {
    const response = await service.stream(
      request,
      request.quote.offer.buyerNodeId,
      new AbortController().signal,
      async () => {},
    );
    assert.ok(response.result);
    assert.equal(memory.writes(), 0);
    assert.equal(f.calls(), 1);
  } finally {
    await runtime.close();
  }
});
