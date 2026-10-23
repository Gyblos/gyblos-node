// Owns offline inference response observation regressions for @gyblos/core; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { observeInferenceResponse } from '@gyblos/core/inference-observation';
import { assessCharge } from '@gyblos/core/metering';
import { ENGINE_DONE_REASONS } from '@gyblos/engine-ollama/constants';

const expected = {
  requestId: 'id',
  offer: 'offer',
  model: 'model',
  digest: 'digest',
};
const goodBody = {
  ...expected,
  content: 'answer',
  done: true,
  doneReason: ENGINE_DONE_REASONS.STOP,
  usage: {
    prompt_eval_count: 10,
    eval_count: 6,
    total_duration: 100,
    load_duration: 10,
    prompt_eval_duration: 20,
    eval_duration: 70,
  },
  billedTokens: { input: 10, output: 6 },
};
function observe(status: number, body: unknown, caseName = 'honest') {
  const input = {
    status,
    body,
    caseName,
    expected,
    inputTokens: 10,
    countOutput: (text: string) => text.length,
  };
  return observeInferenceResponse(input);
}

void test('HTTP engine failure is recognized in an ordinary honest scenario', () => {
  const result = observe(502, { requestId: 'id', error: 'failed' });
  assert.equal(result.failed, true);
  assert.equal(
    assessCharge(10n, result.recounted, result.delivered, result.failed)
      .anomaly,
    'overcharge',
  );
});

void test('successful output cannot be labelled failed by an experiment name', () => {
  assert.equal(observe(200, goodBody, 'engine-interrupted').failed, false);
});

void test('wrong seller identity is rejected before accepting a measurement', () => {
  for (const field of ['offer', 'model', 'digest'] as const) {
    let persisted = false;
    assert.throws(() => {
      observe(200, { ...goodBody, [field]: 'untrusted' });
      persisted = true;
    }, /identity/i);
    assert.equal(persisted, false);
  }
});

void test('successful responses with missing usage are rejected before accepting measurements', () => {
  assert.throws(
    () => observe(200, { ...goodBody, usage: undefined }),
    /usage/i,
  );
});

void test('response usage is sanitized before it reaches evidence and failed billing cannot leak text', () => {
  const secret = 'private content must not be stored';
  const usage = {
    prompt_eval_count: 10,
    eval_count: 6,
    total_duration: 100,
    load_duration: 10,
    prompt_eval_duration: 20,
    eval_duration: 70,
    prompt: secret,
  };
  const success = observe(200, { ...goodBody, usage });
  assert.equal(JSON.stringify(success.body.usage).includes(secret), false);
  const failure = observe(502, {
    requestId: 'id',
    usage,
    billedTokens: { input: secret, output: secret },
  });
  assert.equal(failure.engineTokens, null);
  assert.equal(failure.body.billedTokens, undefined);
  assert.equal(failure.body.usage, undefined);
});

void test('a successful status without content is malformed rather than an engine failure claim', () => {
  assert.throws(
    () => observe(200, { ...goodBody, content: undefined }),
    /malformed/i,
  );
});
