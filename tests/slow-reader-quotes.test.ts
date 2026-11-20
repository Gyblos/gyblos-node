// A seller too slow to read a request in time refuses it at quote time, before the buyer sends any prompt.
// The seller learns its reading speed from its own engine; the buyer sends only a rounded estimate of the
// input size, and a refusal moves it to another seller without counting against the slow one.
// Synthetic engines and loopback control only; no Ollama, network or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER, FREE_CHAT_DETAILS } from '@gyblos/buyer/constants';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { stickySellers } from '@gyblos/buyer/free-selection';
import {
  estimatedInputTokens,
  INPUT_SIZE_STEP,
} from '@gyblos/buyer/input-size';
import {
  selectVerifiedBuyerQuote,
  type VerifiedSelectionDependencies,
} from '@gyblos/buyer/selection';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { refusedDetail } from '@gyblos/buyer/slow-seller';
import { readsInTime } from '@gyblos/config';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { readingSpeedEngine } from '@gyblos/node/reading-speed';
import {
  CONTROL_CODES,
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
} from '@gyblos/protocol/constants';
import {
  controlRequestDigest,
  parseControlQuery,
} from '@gyblos/protocol/control-requests';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  EngineError,
  type Engine,
  type EngineInput,
} from '@gyblos/protocol/engine';
import type { ControlService } from '@gyblos/transport-iroh/control-server';

import { selectionFixture } from './support/buyer-selection';
import { controlFixture } from './support/control-fixture';

type SellerFailure = Parameters<
  NonNullable<VerifiedSelectionDependencies['onSellerFailure']>
>[0];

void test('reading fits when the estimated reading time leaves room to answer within the deadline', () => {
  // An unknown speed never refuses.
  assert.equal(readsInTime(7_000, 4096, undefined), true);
  // ~7k tokens at 20 tokens/s is 350 s: past any deadline.
  assert.equal(readsInTime(7_000, 4096, 20), false);
  // At 200 tokens/s it is 35 s.
  assert.equal(readsInTime(7_000, 4096, 200), true);
  // The answer keeps its reserve: reading that ends just before the deadline does not fit.
  assert.equal(readsInTime(1_000, 128, 1_000 / 99), false);
});

void test('a quote request may carry the input size; it must be a positive integer within a context', async () => {
  const source = await controlFixture(true);
  const sized = {
    ...source.request,
    params: { ...source.request.params, inputTokens: 7_000 },
  };
  assert.deepEqual(parseControlQuery(sized).params, sized.params);
  assert.notEqual(
    await controlRequestDigest(sized),
    await controlRequestDigest(source.request),
  );
  for (const inputTokens of [0, -1, 1.5, '10', 1e9])
    assert.throws(
      () =>
        parseControlQuery({
          ...source.request,
          params: { ...source.request.params, inputTokens },
        }),
      { code: CONTROL_CODES.INVALID },
      String(inputTokens),
    );
});

void test('an offer too slow to read the request refuses the quote; a smaller or unsized one is quoted', async () => {
  const source = await controlFixture(true);
  const quote = (inputTokens: number | undefined, speed: number | undefined) =>
    createControlQuote(
      {
        ...source.request,
        params: {
          ...source.request.params,
          ...(inputTokens === undefined ? {} : { inputTokens }),
        },
      },
      {
        ...source.context,
        models: source.context.models.map((model) => ({
          ...model,
          readingTokensPerSecond: () => speed,
        })),
        remoteNodeId: source.request.params.buyerNodeId,
      },
      source.ownerSigner,
    );
  await assert.rejects(quote(7_000, 20), { code: CONTROL_CODES.TOO_SLOW });
  // 500 tokens at 20 tokens/s is 25 s.
  await quote(500, 20);
  // Without a size, or without a measured speed, nothing is refused.
  await quote(undefined, 20);
  const offer = (await quote(7_000, undefined)).offer;
  // The signed offer is unchanged.
  assert.equal(Object.hasOwn(offer, 'inputTokens'), false);
});

const usage = (inputTokens: number, inputDurationNs: number) => ({
  inputTokens,
  outputTokens: 1,
  totalDurationNs: inputDurationNs,
  loadDurationNs: 0,
  inputDurationNs,
  outputDurationNs: 0,
});
function fakeEngine(generate: (input: EngineInput) => Promise<unknown>) {
  return {
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest',
    }),
    describe: async () => ({ name: 'synthetic', contextTokens: 16_384 }),
    supportsTools: () => true,
    generate,
  } as unknown as Engine;
}

void test('the seller learns its reading speed from its engine, ignoring prompts too short to measure', async () => {
  let next = usage(1_000, 10e9);
  const reading = readingSpeedEngine(
    fakeEngine(async () => ({
      text: 'ok',
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: next,
    })),
  );
  assert.equal(reading.tokensPerSecond(), undefined);
  assert.equal(reading.engine.supportsTools?.(), true);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  assert.equal(reading.tokensPerSecond(), 100);
  // A short prompt (mostly cached, or tiny) says little about reading speed.
  next = usage(255, 1);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  assert.equal(reading.tokensPerSecond(), 100);
  // An engine that does not time the input (declared usage) measures nothing.
  next = usage(5_000, 0);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  assert.equal(reading.tokensPerSecond(), 100);
  // Later samples move the estimate toward them.
  next = usage(2_000, 10e9);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  const speed = reading.tokensPerSecond()!;
  assert.ok(speed > 100 && speed < 200, String(speed));
});

void test('a timeout teaches nothing: its time also holds queueing, model loading and hidden reasoning', async () => {
  const reading = readingSpeedEngine(
    fakeEngine(async () => {
      throw new EngineError(ENGINE_ERROR_CODES.TIMEOUT);
    }),
  );
  await assert.rejects(
    reading.engine.generate({ prompt: 'x', maxTokens: 1, inputTokens: 7_000 }),
    { code: ENGINE_ERROR_CODES.TIMEOUT },
  );
  assert.equal(reading.tokensPerSecond(), undefined);
});

void test('the buyer sends the input size, and a too-slow refusal moves on without cooling the seller', async (t) => {
  const run = await selectionFixture(true, (context) => ({
    ...context,
    models: context.models.map((model) => ({
      ...model,
      readingTokensPerSecond: () => 20,
    })),
  }));
  t.after(() => run.wire.close());
  const sent: unknown[] = [];
  const original = run.client.requestOffer.bind(run.client);
  run.client.requestOffer = async (...args) => {
    sent.push(args[0]);
    return original(...args);
  };
  const failures: SellerFailure[] = [];
  const stats = new Map<string, LocalSellerStats>();
  const result = await selectVerifiedBuyerQuote(
    { ...run.config, request: { ...run.config.request, inputTokens: 7_168 } },
    {
      ...run.dependencies,
      stats,
      onSellerFailure: (failure) => failures.push(failure),
    },
  );
  assert.equal(result.ok, false);
  assert.equal((sent[0] as { inputTokens?: number }).inputTokens, 7_168);
  assert.equal(failures[0]?.code, CONTROL_CODES.TOO_SLOW);
  const nodeId = run.config.sellers[0]!.nodeId;
  assert.equal(stats.get(nodeId)?.cooldownUntil ?? null, null);
  assert.equal(stats.get(nodeId)?.failures ?? 0, 0);
});

void test('the buyer estimates the input size from the conversation and tools, rounded up to whole steps', () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(4_000) }];
  // About 1000 tokens: one step.
  assert.equal(estimatedInputTokens({ messages }), INPUT_SIZE_STEP);
  assert.equal(
    estimatedInputTokens({ messages: [{ role: 'user', content: 'hi' }] }),
    INPUT_SIZE_STEP,
  );
  const withTools = estimatedInputTokens({
    messages,
    tools: [
      {
        name: 'shell',
        description: 'd'.repeat(400),
        parameters: '{"type":"object"}',
      },
    ],
  });
  assert.equal(withTools, 2 * INPUT_SIZE_STEP);
});

void test('a free request asks selection with its estimated input size', async () => {
  const asked: { inputTokens?: number }[] = [];
  const input = {
    messages: [{ role: 'user' as const, content: 'x'.repeat(4_000) }],
    maxTokens: 5,
  };
  await assert.rejects(
    executeBuyerFree(input, {
      select: async (_excluded, _signal, needs) => {
        asked.push(needs ?? {});
        throw new Error('stop after selection');
      },
      execute: async () => assert.fail('nothing executes'),
    }),
  );
  assert.equal(asked[0]?.inputTokens, estimatedInputTokens(input));
});

// A seller from before this change parses quotes with the exact keys it knew: an unknown key is invalid.
function olderSeller(service: ControlService): ControlService {
  return {
    ...service,
    respond(value, peer, signal) {
      const query = value as { params?: Record<string, unknown> };
      if (!query.params || !Object.hasOwn(query.params, 'inputTokens'))
        return service.respond(value, peer, signal);
      const { inputTokens, ...params } = query.params;
      return service.respond(
        { ...query, params: { ...params, unknownKey: inputTokens } },
        peer,
        signal,
      );
    },
  };
}

void test('a seller from before the input size is asked again without it, chosen, and not cooled down', async (t) => {
  const run = await selectionFixture(true, undefined, olderSeller);
  t.after(() => run.wire.close());
  const sent: { inputTokens?: number }[] = [];
  const original = run.client.requestOffer.bind(run.client);
  run.client.requestOffer = async (...args) => {
    sent.push(args[0]);
    return original(...args);
  };
  const failures: SellerFailure[] = [];
  const stats = new Map<string, LocalSellerStats>();
  const result = await selectVerifiedBuyerQuote(
    { ...run.config, request: { ...run.config.request, inputTokens: 7_168 } },
    {
      ...run.dependencies,
      stats,
      onSellerFailure: (failure) => failures.push(failure),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.inputTokens, 7_168);
  assert.equal(Object.hasOwn(sent[1]!, 'inputTokens'), false);
  assert.deepEqual(failures, []);
  const nodeId = run.config.sellers[0]!.nodeId;
  assert.equal(stats.get(nodeId)?.cooldownUntil ?? null, null);
  assert.equal(stats.get(nodeId)?.failures ?? 0, 0);
});

void test("the buyer's own failure checking a quote is not retried without the size", async (t) => {
  const run = await selectionFixture(true);
  t.after(() => run.wire.close());
  let calls = 0;
  run.client.requestOffer = async () => {
    calls++;
    throw new ControlError(CONTROL_CODES.INVALID);
  };
  const result = await selectVerifiedBuyerQuote(
    { ...run.config, request: { ...run.config.request, inputTokens: 7_168 } },
    run.dependencies,
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

void test('the seller that just served the conversation is not sent the size its prompt cache covers', async (t) => {
  const run = await selectionFixture(true, (context) => ({
    ...context,
    models: context.models.map((model) => ({
      ...model,
      readingTokensPerSecond: () => 20,
    })),
  }));
  t.after(() => run.wire.close());
  const sent: unknown[] = [];
  const original = run.client.requestOffer.bind(run.client);
  run.client.requestOffer = async (...args) => {
    sent.push(args[0]);
    return original(...args);
  };
  const result = await selectVerifiedBuyerQuote(
    {
      ...run.config,
      previousSeller: run.config.sellers[0]!.nodeId,
      warmSeller: run.config.sellers[0]!.nodeId,
      request: { ...run.config.request, inputTokens: 7_168 },
    },
    run.dependencies,
  );
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(sent[0] as object, 'inputTokens'), false);
});

void test('a conversation seller is warm only shortly after its last answer', () => {
  let clock = 0;
  const sticky = stickySellers(4, () => clock);
  sticky.chose('chat', 'seller');
  assert.equal(sticky.warm('chat'), undefined);
  sticky.served('seller');
  assert.equal(sticky.warm('chat'), 'seller');
  clock += FREE_BUYER.warmCacheMs;
  // Its cache may be gone: it is still preferred, but sent the size like any other seller.
  assert.equal(sticky.warm('chat'), undefined);
  assert.equal(sticky.get('chat'), 'seller');
});

void test('the plain reason is shown only when every seller asked refused for what the request needs', () => {
  const refusals = (...codes: string[]) =>
    new Map(codes.map((code, index) => [`seller-${index}`, code]));
  const { TOOLS, TOO_SLOW, BUSY } = CONTROL_CODES;
  assert.equal(refusedDetail(refusals()), undefined);
  assert.equal(
    refusedDetail(refusals(TOOLS, TOOLS)),
    FREE_CHAT_DETAILS.noToolSeller,
  );
  assert.equal(
    refusedDetail(refusals(TOO_SLOW, TOO_SLOW)),
    FREE_CHAT_DETAILS.noFastSeller,
  );
  // The sellers with tools were all too slow: the size is what no seller can serve.
  assert.equal(
    refusedDetail(refusals(TOOLS, TOO_SLOW)),
    FREE_CHAT_DETAILS.noFastSeller,
  );
  // Another seller was busy (or gone): neither reason explains the failure.
  assert.equal(refusedDetail(refusals(TOO_SLOW, BUSY)), undefined);
  assert.equal(refusedDetail(refusals(TOOLS, BUSY)), undefined);
});
