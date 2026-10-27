// Native free ALPN dispatch over encrypted loopback, with a synthetic engine and no HTTP/payment server.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { createSellerControlService } from '@gyblos/node/control';
import type { SellerFreeExecutionOptions } from '@gyblos/node/free-execution';
import {
  sellerLimits,
  type SellerLimits,
} from '@gyblos/node/node-config-limits';
import { createSellerRecords } from '@gyblos/node/public-records';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import { matchFreeExecutionResponse } from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionRequest,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

// Runs one signed free request twice over one connection under the seller's [limits].
async function exchangeTwice(limits: SellerLimits) {
  const source = await controlFixture(true);
  const now = Date.now();
  source.setNow(now);
  source.setReadiness({ observedAt: now, validUntil: now + 20000 });
  source.catalog.issuedAt = now;
  source.catalog.expiresAt = now + 60000;
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
  const runtime: SellerFreeExecutionOptions = {
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
    maxFreeBuyers: limits.maxFreeBuyers,
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
  };
  let sequence = source.catalog.sequence;
  const records = await createSellerRecords({
    template: source.catalog,
    signer: nodeSigner,
    now: source.context.now,
    validUntil: () => source.context.readiness().validUntil,
    sequence: {
      next: async (minimum = 0) => {
        sequence = Math.max(sequence, minimum) + 1;
        return sequence;
      },
    },
  });
  source.context.catalog = records.current();
  if (source.context.catalog.record.kind !== PUBLIC_RECORD_KINDS.CATALOG)
    throw new Error('Synthetic catalog required');
  source.request.params.catalogDigest = await catalogDigestV2(
    source.context.catalog.record,
  );
  const control = {
    offer: runtime.offer,
    records,
    service: createSellerControlService({
      context: source.context,
      ownerSigner: source.ownerSigner,
      nodeSigner,
    }),
  };
  const server = serveSellerTransport(seller, control, {
    ...runtime,
    relayOnly: false,
    limits,
  });
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
    const first = await matchFreeExecutionResponse(
      await within(exchange()),
      request,
    );
    // The refusal, if any: a code from the seller or a closed connection.
    const second = await within(exchange())
      .then((response) => matchFreeExecutionResponse(response, request))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    connection.close(1n, []);
    return { first, second, calls };
  } finally {
    await server.close();
    await buyer.close();
  }
}

void test(
  'native free Iroh executes a signed quote, rejects replay and never reaches HTTP',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { first, second, calls } = await exchangeTwice(sellerLimits());
    assert.equal(first.text, 'answer');
    assert.equal(
      (second as { code?: string }).code,
      FREE_EXECUTION_CODES.REPLAY,
    );
    assert.equal(calls, 1);
  },
);

void test(
  'the seller transport serves free requests under the configured [limits]',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    // One request per minute: the second is refused before the replay check ever runs.
    const { first, second, calls } = await exchangeTwice(
      sellerLimits({ requestsPerMinute: 1 }),
    );
    assert.equal(first.text, 'answer');
    assert.ok(second, 'second request must fail');
    assert.notEqual(
      (second as { code?: string }).code,
      FREE_EXECUTION_CODES.REPLAY,
    );
    assert.equal(calls, 1);
  },
);
