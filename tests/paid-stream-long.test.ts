// Exercises long paid answers through the product executor and public framed transport.
// Engines, authenticated peers and payment effects are synthetic; no sockets, files or chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { PaidSellerLedger } from '@gyblos/core/paid-admission';
import { recountedMeter } from '@gyblos/node/free-meter';
import { createSellerPaidExecution } from '@gyblos/node/paid-execution';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';
import {
  buildPaidExecutionRequest,
  paidExecutionDigest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  createPaidStreamVerifier,
  decodePaidStreamEvent,
  encodePaidExecutionRequest,
  encodePaidStreamEvent,
} from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import {
  servePaidExecutionStream,
  type PaidExecutionService,
} from '@gyblos/transport-iroh/paid-server';

import { controlFixture } from './support/control-fixture';
import { settled } from './support/paid-fixture';
import { FEE, recordingPayment } from './support/paid-seller';

async function fixture(maxTokens = 20000, chunkSize = 1) {
  const source = await controlFixture(false);
  const prices = {
    inputAtomicPerMtok: '1000000',
    outputAtomicPerMtok: '1000000',
  };
  for (const entry of source.catalog.models) {
    entry.contextTokens = 65536;
    Object.assign(entry.pricing, prices);
  }
  const model = source.context.models[0]!;
  model.model.contextTokens = 65536;
  source.context.catalog = await signPublicV2(
    source.catalog,
    source.nodeSigner,
  );
  Object.assign(source.request.params, {
    catalogDigest: await catalogDigestV2(source.catalog),
    maxTokens,
    maxAtomic: '100000',
    priceCeilings: prices,
  });
  const quote = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  const paid = buildPaidExecutionRequest(
    quote,
    {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
      maxTokens,
    },
    {
      channelId: 'c'.repeat(64),
      payer: quote.offer.buyer,
      requestDigest: quote.offer.requestDigest,
      maxAtomic: quote.offer.maxAtomic,
      payload: Buffer.from('open').toString('base64'),
    },
  );
  const payment = recordingPayment({
    network: quote.offer.network,
    mint: quote.offer.mint,
    payTo: quote.offer.payTo,
    feePayer: quote.offer.feePayer,
    authorizer: quote.offer.authorizer,
    ...FEE,
  });
  let generations = 0;
  const service = createSellerPaidExecution({
    owner: source.context.owner,
    nodeId: source.context.nodeId,
    selection: model.selection,
    reasoning: model.reasoning,
    model: model.model,
    capabilities: model.capabilities,
    readiness: source.context.readiness,
    now: source.context.now,
    ledger: new PaidSellerLedger(source.context.now() - 1),
    payment: payment.server,
    settlement: { signal: new AbortController().signal, waitMs: 50 },
    meter: recountedMeter({
      input: () => 4,
      chat: () => 4,
      count: (text) => text.length,
    }),
    engine: {
      describe: async () => model.model,
      capabilities: () => model.capabilities,
      async generate(input) {
        generations++;
        for (let index = 0; index < maxTokens; index += chunkSize)
          await input.onText?.(
            'x'.repeat(Math.min(chunkSize, maxTokens - index)),
          );
        return {
          text: 'x'.repeat(maxTokens),
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: {
            inputTokens: 4,
            outputTokens: maxTokens,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
        };
      },
    },
  });
  return {
    paid,
    payment,
    service,
    peer: source.context.remoteNodeId,
    generations: () => generations,
  };
}

async function transport(
  paid: PaidExecutionRequest,
  service: PaidExecutionService,
  peer: string,
  abortAfter?: number,
) {
  const request = encodePaidExecutionRequest(paid);
  const verifier = await createPaidStreamVerifier(paid);
  let offset = 0;
  let delivered = 0;
  let bytes = 0;
  let frames = 0;
  let closed = 0;
  let finished = 0;
  let released = 0;
  const controller = new AbortController();
  let terminal: PaidExecutionResponse | undefined;
  const stream: ControlStream = {
    recv: {
      async readExact(size) {
        const part = request.subarray(offset, offset + size);
        offset += size;
        return [...part];
      },
      read: async () => [],
    },
    send: {
      async writeAll(value) {
        const event = decodePaidStreamEvent(Uint8Array.from(value));
        if (event.type === PAID_STREAM.events.DELTA && frames === abortAfter) {
          controller.abort();
          throw new Error(
            'Synthetic connection closed before acknowledging this frame.',
          );
        }
        const accepted = await verifier.accept(event);
        frames++;
        bytes += value.length;
        delivered += accepted.delta?.length ?? 0;
        if (accepted.terminal) terminal = accepted.terminal;
      },
      async finish() {
        finished++;
      },
    },
  };
  await servePaidExecutionStream(
    stream,
    service,
    peer,
    () => {
      closed++;
    },
    controller.signal,
    () => () => {
      released++;
    },
  );
  return {
    delivered,
    bytes,
    frames,
    closed,
    finished,
    released,
    terminal,
    verifier,
  };
}

async function completed(
  paid: PaidExecutionRequest,
  text: string,
  outputTokens: number,
): Promise<PaidExecutionResponse> {
  const chargedAtomic = String(4 + outputTokens);
  return {
    version: PAID_EXECUTION.version,
    requestId: paid.requestId,
    requestDigest: await paidExecutionDigest(paid),
    result: {
      text,
      usage: { inputTokens: 4, outputTokens },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
    charge: { inputTokens: 4, outputTokens, chargedAtomic },
    payment: {
      settlement: {
        ...settled(paid, chargedAtomic).settlement,
        ...settlementShares(chargedAtomic, FEE.protocolFeeBps),
      },
    },
  };
}

void test('a 20000-token paid answer finishes and charges its verified usage through the public transport', async () => {
  const value = await fixture();
  const result = await transport(value.paid, value.service, value.peer);
  assert.equal(result.terminal?.error, undefined);
  assert.equal(result.delivered, 20000);
  assert.equal(result.frames, 20001);
  assert.ok(result.bytes <= PAID_STREAM.totalBytes);
  assert.equal(result.closed, 0);
  assert.equal(result.finished, 1);
  assert.equal(result.released, 1);
  assert.equal(value.generations(), 1);
  assert.deepEqual(result.terminal?.charge, {
    inputTokens: 4,
    outputTokens: 20000,
    chargedAtomic: '20004',
  });
  assert.equal(result.terminal?.payment?.settlement?.refundedAtomic, '79996');
  assert.deepEqual(
    value.payment.calls.settle.map((call) => call.chargedAtomic),
    ['20004'],
  );
  result.verifier.finish();
});

void test('the maximum paid token deltas leave room for the complete terminal', async () => {
  const value = await fixture(32768);
  const text = 'x'.repeat(32768);
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      for (const character of text) await onDelta(character);
      return completed(value.paid, text, 32768);
    },
  };
  const result = await transport(value.paid, service, value.peer);
  assert.equal(result.delivered, 32768);
  assert.equal(result.frames, 32769);
  assert.equal(result.terminal?.result?.text, text);
  assert.equal(result.closed, 0);
  result.verifier.finish();
});

void test('escaped paid deltas leave room for the complete correlated terminal', async () => {
  const value = await fixture();
  const chunk = '\u0000'.repeat(16);
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      for (let index = 0; index < 10000; index++) await onDelta(chunk);
      return completed(value.paid, chunk.repeat(10000), 20000);
    },
  };
  const result = await transport(value.paid, service, value.peer);
  assert.equal(result.delivered, 160000);
  assert.equal(result.frames, 10001);
  assert.ok(result.bytes <= PAID_STREAM.totalBytes);
  assert.equal(result.terminal?.charge?.chargedAtomic, '20004');
  assert.equal(result.closed, 0);
  assert.equal(result.finished, 1);
  result.verifier.finish();
});

void test('a broken write cancels a long paid answer and settles only acknowledged output without retry', async () => {
  const value = await fixture();
  let response: PaidExecutionResponse | undefined;
  const service: PaidExecutionService = {
    async stream(...args) {
      response = await value.service.stream(...args);
      return response;
    },
  };
  const result = await transport(value.paid, service, value.peer, 64);
  assert.equal(result.delivered, 64);
  assert.equal(result.terminal, undefined);
  assert.equal(result.closed, 1);
  assert.equal(result.finished, 0);
  assert.equal(result.released, 1);
  assert.equal(response?.error?.code, PAID_EXECUTION_CODES.CANCELLED);
  assert.equal(response?.error?.delivered?.outputTokens, 64);
  assert.equal(response?.charge?.chargedAtomic, '68');
  assert.equal(response?.payment?.settlement?.refundedAtomic, '99932');
  assert.equal(value.generations(), 1);
  assert.deepEqual(
    value.payment.calls.settle.map((call) => call.chargedAtomic),
    ['68'],
  );
});

void test('paid stream byte capacity includes escaped output, every maximum delta header and a whole terminal frame', async () => {
  const value = await fixture();
  const frame = encodePaidStreamEvent({
    version: PAID_EXECUTION.version,
    requestId: value.paid.requestId,
    requestDigest: 'f'.repeat(64),
    sequence: PAID_STREAM.maxEvents - 2,
    type: PAID_STREAM.events.DELTA,
    text: '\u0000',
  });
  const overhead = frame.length - 6;
  assert.equal(PAID_STREAM.maxEvents, 32769);
  assert.ok(PAID_STREAM.terminalReserveBytes >= PAID_STREAM.eventBytes + 4);
  assert.equal(
    PAID_STREAM.totalBytes - PAID_STREAM.terminalReserveBytes,
    overhead * (PAID_STREAM.maxEvents - 1) + FREE_EXECUTION.outputBytes * 6,
  );
});

void test('a cut within a fragmented engine delta preserves each acknowledged paid frame', async () => {
  const value = await fixture(20000, 16384);
  let response: PaidExecutionResponse | undefined;
  const service: PaidExecutionService = {
    async stream(...args) {
      response = await value.service.stream(...args);
      return response;
    },
  };
  const result = await transport(value.paid, service, value.peer, 1);
  assert.equal(result.delivered, 8192);
  assert.equal(result.closed, 1);
  assert.equal(result.finished, 0);
  assert.equal(result.released, 1);
  assert.equal(result.terminal, undefined);
  assert.equal(response?.error?.code, PAID_EXECUTION_CODES.CANCELLED);
  assert.equal(response?.error?.delivered?.outputTokens, 8192);
  assert.equal(response?.charge?.chargedAtomic, '8196');
  assert.equal(response?.payment?.settlement?.refundedAtomic, '91804');
  assert.deepEqual(
    value.payment.calls.settle.map((call) => call.chargedAtomic),
    ['8196'],
  );
  assert.equal(value.generations(), 1);
});
