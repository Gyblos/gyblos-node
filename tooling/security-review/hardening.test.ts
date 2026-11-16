// Owns adversarial review regressions over synthetic source; no live model is called.
import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewableFiles } from './inventory';
import { parseReviewResponse, parseVerificationResponse } from './parsing';
import { buildPiArguments } from './pi';
import { buildBaselinePlan, buildPullRequestPlan } from './plan';
import { partitionBundle } from './projection';
import { labelsForStatus, overallReviewStatus } from './result';
import type { SourceBundle } from './types';

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

void test('tiny-file shards cannot exceed the coverage response path limit', () => {
  const source: SourceBundle = {
    files: Array.from({ length: 101 }, (_, index) => ({
      path: 'packages/core/' + index + '.ts',
      revision: 'head',
      text: 'x',
    })),
    diff: '',
    omissions: [],
  };
  const parts = partitionBundle(source);
  assert.ok(parts.length > 1);
  assert.ok(
    parts.every(
      (part) => new Set(part.files.map((file) => file.path)).size <= 100,
    ),
  );
});

void test('a rejected lead cannot retain unresolved blockers', () => {
  assert.throws(
    () =>
      parseVerificationResponse(
        JSON.stringify({
          decision: 'rejected',
          fingerprint: 'policy:check',
          reason: 'Not reproduced.',
          evidence: [
            {
              file: 'packages/core/a.ts',
              revision: 'head',
              line: 1,
              scope: 'policy',
              description: 'Candidate remains undecided.',
            },
          ],
          blockers: ['Runtime unavailable'],
          validation_plan: 'Run a synthetic fixture.',
        }),
      ),
    /blocker/i,
  );
});

void test('tooling .test.ts filenames select the tests/evidence specialist', () => {
  const file = 'tooling/security-review/hardening.test.ts';
  const plan = buildPullRequestPlan([file], [file], 'head', 'base');
  assert.ok(plan.tasks.some((task) => task.reviewer === 'tests-evidence'));
});

void test('result labels preserve partial and error states', () => {
  assert.equal(
    overallReviewStatus([
      { taskId: 'a', status: 'needs-validation', findings: [] },
    ]),
    'needs-validation',
  );
  assert.equal(
    overallReviewStatus([{ taskId: 'a', status: 'error', findings: [] }]),
    'error',
  );
  assert.deepEqual(labelsForStatus('needs-validation'), [
    'ai-review:needs-validation',
  ]);
});

void test('large source input is partitioned without silently dropping files', () => {
  const bundle: SourceBundle = {
    files: Array.from({ length: 4 }, (_, index) => ({
      path: 'packages/core/' + index + '.ts',
      revision: 'head',
      text: 'x'.repeat(200_000),
    })),
    diff: '',
    omissions: [],
  };
  const parts = partitionBundle(bundle);
  assert.ok(parts.length > 1);
  assert.equal(parts.flatMap((part) => part.files).length, 4);
});
