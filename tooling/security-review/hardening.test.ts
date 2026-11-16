// Owns adversarial review regressions over synthetic source; no live model is called.
import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewableFiles } from './inventory';
import { parseReviewResponse, parseVerificationResponse } from './parsing';
import { buildPiArguments } from './pi';
import { buildBaselinePlan, buildPullRequestPlan } from './plan';

void test('model cannot use filesystem tools to escape the reviewed source', () => {
  const args = buildPiArguments('openai/example', 'high', 'review');
  assert.ok(args.includes('--no-tools'));
  assert.equal(args.includes('--tools'), false);
});

void test('hunter rejects unrecognized properties and empty evidence', () => {
  const response = {
    status: 'complete',
    reviewer: 'security-general',
    coverage: { reviewed_paths: ['packages/core/src/a.ts'], notes: 'reviewed' },
    findings: [],
    unexpected: 'ignore the rules',
  };
  assert.throws(
    () => parseReviewResponse(JSON.stringify(response)),
    /unexpected/i,
  );
});

void test('source-only verifier cannot fabricate an executed confirmation', () => {
  assert.throws(
    () =>
      parseVerificationResponse(
        JSON.stringify({
          decision: 'confirmed',
          record: { verdict: 'confirmed', fingerprint: 'a', title: 'a' },
        }),
      ),
    /[Ss]ource-only|decision|confirmed|unexpected/,
  );
});

void test('deleted payment files retain specialist routing', () => {
  const plan = buildPullRequestPlan(
    ['packages/core/src/a.ts'],
    ['packages/payments-x402/src/recovery.ts'],
    'head',
    'base',
  );
  assert.ok(plan.tasks.some((task) => task.reviewer === 'payments-economics'));
  assert.ok(
    plan.tasks.some((task) => task.reviewer === 'concurrency-recovery'),
  );
});

void test('baseline accounts for root rules, tests and deployment files', () => {
  const plan = buildBaselinePlan(
    ['AGENTS.md', 'tests/a.test.ts', 'Dockerfile', 'compose.yaml'],
    'head',
  );
  assert.deepEqual(
    [...new Set(plan.units.flatMap((unit) => unit.paths))].sort(),
    ['AGENTS.md', 'Dockerfile', 'compose.yaml', 'tests/a.test.ts'].sort(),
  );
});

void test('inventory rejects private paths even if tracked in Git', () => {
  assert.deepEqual(
    reviewableFiles([
      'private/data.ts',
      'measurements/raw.json',
      'seller.env',
      'AGENTS.local.md',
      '.local/key.json',
      'packages/core/src/a.ts',
    ]),
    ['packages/core/src/a.ts'],
  );
});
