// A seller too slow to read a request in time refuses it at quote time, before the buyer sends any prompt.
// The seller learns its reading speed from its own engine; the buyer sends only an estimate of the input
// size, and a refusal moves it to another seller without counting against the slow one.
// Synthetic engines and loopback control only; no Ollama, network or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { estimatedInputTokens } from '@gyblos/buyer/input-size';
import {
  selectVerifiedBuyerQuote,
  type VerifiedSelectionDependencies,
} from '@gyblos/buyer/selection';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { PROMPT_READING, readsInTime } from '@gyblos/config';
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
  assert.ok(PROMPT_READING.answerReserveMs > 0);
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
  next = usage(PROMPT_READING.minSampleTokens - 1, 1);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  assert.equal(reading.tokensPerSecond(), 100);
  // Later samples move the estimate toward them.
  next = usage(2_000, 10e9);
  await reading.engine.generate({ prompt: 'x', maxTokens: 1 });
  const speed = reading.tokensPerSecond()!;
  assert.ok(speed > 100 && speed < 200, String(speed));
});

void test('a request that timed out before any visible token caps the reading speed for a while', async () => {
  let clock = 0;
  let emit = false;
  const reading = readingSpeedEngine(
    fakeEngine(async (input) => {
      clock += 100_000;
      if (emit) await input.onFragment?.();
      throw new EngineError(ENGINE_ERROR_CODES.TIMEOUT);
    }),
    () => clock,
  );
  const timeout = (inputTokens: number, tools?: EngineInput['tools']) =>
    assert.rejects(
      reading.engine.generate({
        prompt: 'x',
        maxTokens: 1,
        inputTokens,
        ...(tools ? { tools } : {}),
      }),
      { code: ENGINE_ERROR_CODES.TIMEOUT },
    );
  // An engine that has never shown a visible fragment may be answering in silence: nothing is learned.
  await timeout(7_000);
  assert.equal(reading.tokensPerSecond(), undefined);
  // A timeout after the first token was answering, not reading: it says nothing about reading.
  emit = true;
  await timeout(700);
  assert.equal(reading.tokensPerSecond(), undefined);
  // Now silence means reading: 7000 tokens not read in 100 s is under 70 tokens per second.
  emit = false;
  await timeout(7_000);
  assert.equal(reading.tokensPerSecond(), 70);
  // A tool call is generated without visible text: a silent timeout with tools says nothing either.
  await timeout(1_000, [{ name: 'shell', description: 'd', parameters: '{}' }]);
  assert.equal(reading.tokensPerSecond(), 70);
  // The cap does not last: a seller that never gets a large request to measure is not stuck refusing.
  clock += PROMPT_READING.timeoutCapMs;
  assert.equal(reading.tokensPerSecond(), undefined);
});

void test('a measurement replaces a timeout cap', async () => {
  let clock = 0;
  let mode: 'answered' | 'silent' | 'ok' = 'answered';
  const reading = readingSpeedEngine(
    fakeEngine(async (input) => {
      clock += 100_000;
      if (mode !== 'silent') await input.onFragment?.();
      if (mode !== 'ok') throw new EngineError(ENGINE_ERROR_CODES.TIMEOUT);
      return {
        text: 'ok',
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: usage(1_000, 5e9),
      };
    }),
    () => clock,
  );
  const ask = () =>
    reading.engine.generate({ prompt: 'x', maxTokens: 1, inputTokens: 7_000 });
  await assert.rejects(ask());
  mode = 'silent';
  await assert.rejects(ask());
  assert.equal(reading.tokensPerSecond(), 70);
  mode = 'ok';
  await ask();
  assert.equal(reading.tokensPerSecond(), 200);
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
    { ...run.config, request: { ...run.config.request, inputTokens: 7_000 } },
    {
      ...run.dependencies,
      stats,
      onSellerFailure: (failure) => failures.push(failure),
    },
  );
  assert.equal(result.ok, false);
  assert.equal((sent[0] as { inputTokens?: number }).inputTokens, 7_000);
  assert.equal(failures[0]?.code, CONTROL_CODES.TOO_SLOW);
  const nodeId = run.config.sellers[0]!.nodeId;
  assert.equal(stats.get(nodeId)?.cooldownUntil ?? null, null);
  assert.equal(stats.get(nodeId)?.failures ?? 0, 0);
});

void test('the buyer estimates the input size from the conversation and tools it will send', () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(4_000) }];
  const estimate = estimatedInputTokens({ messages });
  assert.ok(estimate >= 1_000 && estimate < 1_100, String(estimate));
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
  assert.ok(withTools > estimate + 90, String(withTools));
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

void test('a seller from before the input size is still chosen by a new buyer and not cooled down', async (t) => {
  const run = await selectionFixture(true, undefined, olderSeller);
  t.after(() => run.wire.close());
  const failures: SellerFailure[] = [];
  const stats = new Map<string, LocalSellerStats>();
  const result = await selectVerifiedBuyerQuote(
    { ...run.config, request: { ...run.config.request, inputTokens: 7_000 } },
    {
      ...run.dependencies,
      stats,
      onSellerFailure: (failure) => failures.push(failure),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(failures, []);
  const nodeId = run.config.sellers[0]!.nodeId;
  assert.equal(stats.get(nodeId)?.cooldownUntil ?? null, null);
  assert.equal(stats.get(nodeId)?.failures ?? 0, 0);
});

void test('the seller that served the previous turn is not asked the size its prompt cache mostly covers', async (t) => {
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
      request: { ...run.config.request, inputTokens: 7_000 },
    },
    run.dependencies,
  );
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(sent[0] as object, 'inputTokens'), false);
});
