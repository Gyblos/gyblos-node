// Owns offline synthetic inference case list regressions for @gyblos/node; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { INFERENCE_CASES } from '@gyblos/buyer/constants';
import { createCases } from '@gyblos/buyer/synthetic-cases';

void test('gate adds the separately targeted undercharge before engine termination', () => {
  const cases = createCases('over-request', 'failure-request', 'under-request');
  assert.deepEqual(
    cases.map((entry) => entry.name),
    [
      'honest-1',
      'honest-2',
      'honest-3',
      'overcharge',
      'undercharge',
      'engine-interrupted',
    ],
  );
  assert.equal(new Set(cases.map((entry) => entry.requestId)).size, 6);
  assert.equal(
    cases.find((entry) => entry.name === INFERENCE_CASES.UNDERCHARGE)
      ?.requestId,
    'under-request',
  );
  assert.equal(
    cases.find((entry) => entry.name === INFERENCE_CASES.OVERCHARGE)?.requestId,
    'over-request',
  );
  assert.equal(cases.at(-1)?.requestId, 'failure-request');
  assert.ok(
    cases.find((entry) => entry.name === INFERENCE_CASES.UNDERCHARGE)?.prompt
      .length,
  );
});

void test('optional undercharge scenario retains all original case contents and relative ordering', () => {
  const original = createCases('over-request', 'failure-request');
  const extended = createCases(
    'over-request',
    'failure-request',
    'under-request',
  ).filter((entry) => entry.name !== INFERENCE_CASES.UNDERCHARGE);
  assert.deepEqual(
    original.map(({ name, prompt }) => ({ name, prompt })),
    extended.map(({ name, prompt }) => ({ name, prompt })),
  );
  assert.equal(original.length, 5);
});
