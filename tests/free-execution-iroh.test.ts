// Native free ALPN dispatch over encrypted loopback, with a synthetic engine and no HTTP/payment server.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { OFFER_PRICING_KINDS } from '@gyblos/node/constants';
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';
import { matchFreeExecutionResponse } from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionRequest,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { controlFixture } from './support/control-fixture.js';
import { endpoint, within } from './support/native-fixture.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

void test(
  'native free Iroh executes a signed quote, rejects replay and never reaches HTTP',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const source = await controlFixture(true);
    const seller = await endpoint();
    seller.setAlpns([[...Buffer.from(FREE_EXECUTION.alpn)]]);
    const buyer = await endpoint();
    source.catalog.nodeId = seller.id().toString();
    source.context.nodeId = source.catalog.nodeId;
    source.request.params.buyerNodeId = buyer.id().toString();
    source.context.remoteNodeId = source.request.params.buyerNodeId;
    const nodeSigner = async (bytes: Uint8Array<ArrayBuffer>) =>
      Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    source.context.catalog = await signPublicV2(source.catalog, nodeSigner);
    source.request.params.catalogDigest = await catalogDigestV2(source.catalog);
    const model = source.context.models[0]!;
    let calls = 0;
    const free = createSellerFreeExecution({
      owner: source.context.owner,
      nodeId: source.context.nodeId,
      offer: {
        kind: OFFER_PRICING_KINDS.FREE,
        modelId: MODEL_IDS.QWEN3_0_6B,
        reasoning: model.reasoning,
        caps: { dailyTokenCap: 1000, perBuyerCap: 1000 },
      },
      selection: model.selection,
      model: model.model,
      capabilities: model.capabilities,
      now: source.context.now,
      startedAt: source.context.now() - 1,
      readiness: source.context.readiness,
      tokenizer: { input: () => 4, count: () => 2 },
      engine: {
        describe: async () => model.model,
        capabilities: () => model.capabilities,
        generate: async () => {
          calls++;
          return {
            text: 'answer',
            finishReason: ENGINE_DONE_REASONS.STOP,
            usage: {
              inputTokens: 4,
              outputTokens: 2,
              totalDurationNs: 0,
              loadDurationNs: 0,
              inputDurationNs: 0,
              outputDurationNs: 0,
            },
          };
        },
      },
    });
    const server = serveIroh(
      seller,
      'http://127.0.0.1:1',
      false,
      undefined,
      free,
    );
    try {
      const quote = await createControlQuote(
        {
          ...source.request,
          params: { ...source.request.params, maxTokens: 10 },
        },
        source.context,
        source.ownerSigner,
      );
      const request = {
        version: FREE_EXECUTION.version,
        requestId: quote.offer.requestId,
        quote,
        input: {
          messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
          selection: quote.offer.selection,
          reasoning: quote.offer.reasoning,
          maxTokens: 10,
        },
      };
      const connection = await within(
        buyer.connect(seller.addr(), [...Buffer.from(FREE_EXECUTION.alpn)]),
      );
      const exchange = async () => {
        const stream = await connection.openBi();
        await stream.send.writeAll([...encodeFreeExecutionRequest(request)]);
        await stream.send.finish();
        const reader = new FreeExecutionResponseReader();
        reader.push(
          Uint8Array.from(
            await stream.recv.readToEnd(FREE_EXECUTION.responseBytes + 4),
          ),
        );
        return reader.finish();
      };
      assert.equal(
        (await matchFreeExecutionResponse(await within(exchange()), request))
          .text,
        'answer',
      );
      await assert.rejects(
        matchFreeExecutionResponse(await within(exchange()), request),
        { code: FREE_EXECUTION_CODES.REPLAY },
      );
      assert.equal(calls, 1);
      connection.close(1n, []);
    } finally {
      await server.close();
      await buyer.close();
    }
  },
);
