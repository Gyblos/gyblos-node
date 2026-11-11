// How a free offer counts tokens: recounted with the model's public tokenizer exactly as before, or
// declared by the engine's provider within byte bounds, never refunded.
// Pure; synthetic tokenizers and results.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_METERING } from '@gyblos/node/constants';
import { DECLARED_METER, recountedMeter } from '@gyblos/node/free-meter';
import { offerMeter } from '@gyblos/node/seller-offers';
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
  chat: () => 7,
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
  const meter = recountedMeter({
    input: () => 1,
    chat: () => 1,
    count: () => 0,
  });
  assert.equal(meter.delivered('a', 10), 1);
  const wide = recountedMeter({
    input: () => 1,
    chat: () => 1,
    count: () => 50,
  });
  assert.equal(wide.delivered('héllo', 100), 6);
});

void test('a declared meter reserves the prompt’s UTF-8 bytes plus the chat template allowance', () => {
  assert.equal(DECLARED_METER.mode, CONTROL_METERING_MODES.DECLARED);
  assert.equal(
    DECLARED_METER.input('héllo'),
    6 + FREE_METERING.declaredTemplateTokens,
  );
});

void test('a declared stream counts the fewest tokens its bytes can hold', () => {
  const per = FREE_METERING.declaredMaxTokenBytes;
  assert.equal(DECLARED_METER.streamed(''), 0);
  assert.equal(DECLARED_METER.streamed('a'), 1);
  assert.equal(DECLARED_METER.streamed('x'.repeat(per)), 1);
  assert.equal(DECLARED_METER.streamed('x'.repeat(per + 1)), 2);
});

void test('a declared stop reports its delivered bytes, bounded by maxTokens', () => {
  assert.equal(DECLARED_METER.delivered('héllo', 100), 6);
  assert.equal(DECLARED_METER.delivered('hello world', 4), 4);
});

void test('declared usage is the provider’s when plausible for the text', () => {
  assert.deepEqual(DECLARED_METER.usage('answer', usage(9, 3), 70), {
    inputTokens: 9,
    outputTokens: 3,
  });
  assert.deepEqual(DECLARED_METER.usage('', usage(9, 0), 70), {
    inputTokens: 9,
    outputTokens: 0,
  });
});

void test('declared usage below the text’s floor or without input is not plausible', () => {
  const per = FREE_METERING.declaredMaxTokenBytes;
  for (const [text, reported] of [
    ['answer', usage(9, 0)],
    ['x'.repeat(per * 3 + 1), usage(9, 3)],
    ['answer', usage(0, 3)],
    ['answer', usage(Number.NaN, 3)],
    ['answer', usage(9, 1.5)],
  ] as const)
    assert.equal(DECLARED_METER.usage(text, reported, 70), undefined);
});

void test('only a recounted completion may refund its reservation', () => {
  assert.equal(recountedMeter(tokenizer).refunds, true);
  assert.equal(DECLARED_METER.refunds, false);
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
