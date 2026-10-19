import assert from 'node:assert/strict';
import test from 'node:test';

import { createCases } from '../apps/cli/src/inference/cases-data.js';

test('gate adds the separately targeted undercharge before engine termination', () => {
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
    cases.find((entry) => entry.name === 'undercharge')?.requestId,
    'under-request',
  );
  assert.equal(
    cases.find((entry) => entry.name === 'overcharge')?.requestId,
    'over-request',
  );
  assert.equal(cases.at(-1)?.requestId, 'failure-request');
  assert.ok(cases.find((entry) => entry.name === 'undercharge')?.prompt.length);
});

test('optional undercharge scenario retains all original case contents and relative ordering', () => {
  const original = createCases('over-request', 'failure-request');
  const extended = createCases(
    'over-request',
    'failure-request',
    'under-request',
  ).filter((entry) => entry.name !== 'undercharge');
  assert.deepEqual(
    original.map(({ name, prompt }) => ({ name, prompt })),
    extended.map(({ name, prompt }) => ({ name, prompt })),
  );
  assert.equal(original.length, 5);
});
