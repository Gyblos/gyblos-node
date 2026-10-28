// How a free offer counts tokens: recounted with the model's public tokenizer exactly as before, or
// declared by the engine's provider with byte bounds wherever the seller must decide before usage exists.
// Pure; synthetic tokenizers and results.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECLARED_METER,
  offerMeter,
  recountedMeter,
} from '@gyblos/node/free-meter';
import { FREE_METERING } from '@gyblos/node/constants';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import type { EngineUsage } from '@gyblos/protocol/engine';

const usage = (inputTokens: number, outputTokens: number): EngineUsage => ({
  inputTokens,
  outputTokens,
  totalDurationNs: 0,
  loadDurationNs: 0,
  inputDurationNs: 0,
  outputDurationNs: 0,
});
// Three characters per token, and seven prompt tokens for any prompt.
const tokenizer = {
  input: () => 7,
  count: (text: string) => Math.ceil(text.length / 3),
};

void test('a recounted meter counts with the tokenizer, ignoring what the engine reports', () => {
  const meter = recountedMeter(tokenizer);
  assert.equal(meter.mode, CONTROL_METERING_MODES.RECOUNTED);
  assert.equal(meter.input('hello'), 7);
  assert.equal(meter.streamed('answer'), 2);
  assert.deepEqual(meter.usage('answer', usage(99, 99), 7), {
    inputTokens: 7,
    outputTokens: 2,
  });
});

void test('a recounted stop reports at least one token and never more than the delivered bytes', () => {
  const meter = recountedMeter({ input: () => 1, count: () => 0 });
  assert.equal(meter.delivered('a', 10), 1);
  const wide = recountedMeter({ input: () => 1, count: () => 50 });
  assert.equal(wide.delivered('héllo', 100), 6);
});

void test('a declared meter reserves the prompt’s UTF-8 bytes plus the chat template allowance', () => {
  assert.equal(DECLARED_METER.mode, CONTROL_METERING_MODES.DECLARED);
  assert.equal(
    DECLARED_METER.input('héllo'),
    6 + FREE_METERING.declaredTemplateTokens,
  );
});

void test('a declared stream never counts more than one token before the provider reports usage', () => {
  assert.equal(DECLARED_METER.streamed(''), 0);
  assert.equal(DECLARED_METER.streamed('a long streamed answer'), 1);
});

void test('a declared stop reports its delivered bytes, bounded by maxTokens', () => {
  assert.equal(DECLARED_METER.delivered('héllo', 100), 6);
  assert.equal(DECLARED_METER.delivered('hello world', 4), 4);
});

void test('declared usage is the provider’s, not the seller’s estimate', () => {
  assert.deepEqual(DECLARED_METER.usage('answer', usage(9, 3), 70), {
    inputTokens: 9,
    outputTokens: 3,
  });
});

void test('an offer’s meter follows its metering mode', async () => {
  const recounted = await offerMeter({
    mode: CONTROL_METERING_MODES.RECOUNTED,
    tokenizer: async () => tokenizer,
  });
  assert.equal(recounted.mode, CONTROL_METERING_MODES.RECOUNTED);
  assert.equal(recounted.input('x'), 7);
  assert.equal(
    await offerMeter({ mode: CONTROL_METERING_MODES.DECLARED }),
    DECLARED_METER,
  );
});
