// Receipt persistence cannot consume the inference transport deadline or discard a completed answer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import {
  createSellerReceiptRuntime,
  type LocalReceiptStore,
} from '@gyblos/node/receipts';
import { ENGINE_KINDS } from '@gyblos/protocol/constants';
import { encodeFreeExecutionRequest } from '@gyblos/protocol/free-execution-framing';
import { serveFreeExecutionStream } from '@gyblos/transport-iroh/free-server';

import { freeSellerFixture } from './support/free-seller';

void test('slow receipt storage cannot discard a successful inference at the transport deadline', async () => {
  const f = await freeSellerFixture();
  const request = await f.request();
  const bytes = encodeFreeExecutionRequest(request);
  let offset = 0;
  let writes = 0;
  let closes = 0;
  const store: LocalReceiptStore = {
    async put() {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
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
  const stream = {
    recv: {
      async readExact(length: number) {
        const part = [...bytes.slice(offset, offset + length)];
        offset += length;
        return part;
      },
      async read() {
        return [];
      },
    },
    send: {
      async writeAll() {
        writes++;
      },
      async finish() {},
    },
  };
  try {
    await serveFreeExecutionStream(
      stream,
      service,
      request.quote.offer.buyerNodeId,
      () => {
        closes++;
      },
      new AbortController().signal,
      () => () => {},
      () => true,
      { requestMs: 75 },
    );
    assert.equal(f.calls(), 1);
    assert.equal(writes, 1);
    assert.equal(closes, 0);
  } finally {
    await runtime.close();
    await runtime.settled();
  }
});
