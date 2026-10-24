// Exercises bounded background readiness with synthetic clocks/engines; never starts a node or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { observeControlReadiness } from '@gyblos/node/control-readiness';
import {
  ENGINE_DONE_REASONS,
  MODEL_IDENTITIES,
} from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';

function fixture() {
  let now = 10000;
  let checks = 0;
  const model = { name: 'synthetic', digest: 'synthetic', contextTokens: 2048 };
  const result = {
    text: '',
    finishReason: ENGINE_DONE_REASONS.STOP,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalDurationNs: 0,
      loadDurationNs: 0,
      inputDurationNs: 0,
      outputDurationNs: 0,
    },
  };
  const engine: Engine = {
    describe: async () => model,
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: MODEL_IDENTITIES.DIGEST,
    }),
    generate: async () => result,
  };
  const options = {
    model,
    renewBeforeMs: 20,
    tickMs: 5,
    timeoutMs: 15,
    check: async (_signal: AbortSignal) => {
      checks++;
      return { model, offerExpiresAt: now + 100 };
    },
  };
  const observed = observeControlReadiness(
    engine,
    now + 100,
    () => now,
    options,
  );
  return {
    observed,
    engine,
    options,
    model,
    result,
    checks: () => checks,
    setNow: (value: number) => {
      now = value;
    },
  };
}

void test('renewal extends only a freshly checked deadline and changes observation generation', async () => {
  const source = fixture();
  const before = source.observed.readiness();
  assert.equal(await source.observed.tick(), false);
  assert.equal(source.checks(), 0);
  source.setNow(10080);
  assert.equal(await source.observed.tick(), true);
  const after = source.observed.readiness();
  assert.equal(after.observedAt, 10080);
  assert.equal(after.validUntil, 10180);
  assert.ok(after.generation > before.generation);
  await source.observed.stop();
});

void test('expired readiness can recover; a failed check never extends it', async () => {
  const source = fixture();
  source.setNow(10100);
  source.options.check = async () => {
    throw new Error('PRIVATE_FAILURE');
  };
  assert.equal(await source.observed.tick(), false);
  assert.ok(source.observed.readiness().validUntil <= 10100);
  source.options.check = async () => ({
    model: source.model,
    offerExpiresAt: 10200,
  });
  assert.equal(await source.observed.tick(), true);
  assert.equal(source.observed.readiness().validUntil, 10200);
  await source.observed.stop();
});

void test('active inference prevents a readiness check and recovery does not repeat inference', async () => {
  const source = fixture();
  let finish!: () => void;
  source.engine.generate = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return source.result;
  };
  const generating = source.observed.engine.generate({
    prompt: 'synthetic',
    maxTokens: 1,
  });
  source.setNow(10100);
  assert.equal(await source.observed.tick(), false);
  assert.equal(source.checks(), 0);
  assert.equal(source.observed.readiness().busy, true);
  finish();
  await generating;
  assert.equal(await source.observed.tick(), true);
  assert.equal(source.checks(), 1);
  await source.observed.stop();
});

void test('inference cancels a pending check; its late success cannot restore readiness', async () => {
  const source = fixture();
  let finish!: () => void;
  let signal!: AbortSignal;
  source.options.check = async (input) => {
    signal = input;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { model: source.model, offerExpiresAt: 10500 };
  };
  source.setNow(10080);
  const checking = source.observed.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await source.observed.engine.generate({ prompt: 'synthetic', maxTokens: 1 });
  assert.equal(signal.aborted, true);
  finish();
  assert.equal(await checking, false);
  assert.ok(source.observed.readiness().validUntil <= 10080);
  await source.observed.stop();
});

void test('timed out checks retain their actual work slot until settlement without queued retries', async () => {
  const source = fixture();
  let attempts = 0;
  let finish!: () => void;
  source.options.check = async () => {
    attempts++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { model: source.model, offerExpiresAt: 10500 };
  };
  source.setNow(10100);
  assert.equal(await source.observed.tick(), false);
  for (let index = 0; index < 10; index++)
    assert.equal(await source.observed.tick(), false);
  assert.equal(attempts, 1);
  await source.observed.stop();
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(source.observed.readiness().validUntil <= 10100);
});

void test('changed model identity, expired results and backwards clocks fail closed', async () => {
  for (const field of ['name', 'digest', 'contextTokens', 'expiry', 'clock']) {
    const source = fixture();
    source.setNow(10080);
    source.options.check = async () => {
      const model = { ...source.model };
      if (field === 'name') model.name = 'other';
      if (field === 'digest') model.digest = 'other';
      if (field === 'contextTokens') model.contextTokens = 4096;
      if (field === 'clock') source.setNow(10079);
      return { model, offerExpiresAt: field === 'expiry' ? 10080 : 10200 };
    };
    assert.equal(await source.observed.tick(), false, field);
    assert.ok(source.observed.readiness().validUntil <= 10080);
    await source.observed.stop();
  }
});

void test('stop invalidates immediately and rejects a late successful check', async () => {
  const source = fixture();
  let finish!: () => void;
  source.options.check = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { model: source.model, offerExpiresAt: 10500 };
  };
  source.setNow(10080);
  const checking = source.observed.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await source.observed.stop();
  assert.ok(source.observed.readiness().validUntil <= 10080);
  finish();
  assert.equal(await checking, false);
  assert.equal(await source.observed.tick(), false);
});

void test('scheduled idle observation refreshes records after busy without another warmup', async () => {
  const source = fixture();
  let updated = 0;
  try {
    await source.observed.engine.generate({
      prompt: 'synthetic',
      maxTokens: 1,
    });
    source.observed.start(async () => {
      updated++;
    });
    const until = Date.now() + 1000;
    while (!updated && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(updated > 0);
    assert.equal(source.checks(), 0);
  } finally {
    await source.observed.stop();
  }
});

void test('failed inference invalidates the observation without retrying or changing the original error', async () => {
  const source = fixture();
  const failure = new Error('synthetic inference failure');
  let calls = 0;
  source.engine.generate = async () => {
    calls++;
    throw failure;
  };
  await assert.rejects(
    source.observed.engine.generate({ prompt: 'synthetic', maxTokens: 1 }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.ok(source.observed.readiness().validUntil <= 10000);
  assert.equal(await source.observed.tick(), true);
  await source.observed.stop();
});
