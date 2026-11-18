// Owns synthetic review integration tests. No real credentials, target processes or model calls are used.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeArtifacts } from './security-review/artifacts';
import { REVIEW_VALUES, REVIEWER_IDS } from './security-review/constants';
import {
  changedFiles,
  repositoryRef,
  trackedFile,
  trackedFiles,
} from './security-review/git';
import {
  parseReviewResponse,
  parseVerificationResponse,
  validateCoverage,
  validateEvidence,
} from './security-review/parsing';
import {
  buildBaselinePlan,
  buildPullRequestPlan,
} from './security-review/plan';
import { createSourceBundle } from './security-review/projection';
import { runReview } from './security-review/runner';
import {
  EVIDENCE,
  exec,
  FILE,
  FINDING,
  fixture,
  hunter,
  success,
} from './security-review/test-fixture';
import type { SourceBundle } from './security-review/types';

void test('baseline and payment PR select independent base and specialist reviews', () => {
  const paths = [
    FILE,
    'packages/protocol/src/a.ts',
    'packages/payments-x402/src/recovery.ts',
    'apps/buyer/src/main.ts',
  ];
  const baseline = buildBaselinePlan(paths, REVIEW_VALUES.HEAD);
  assert.ok(baseline.units.some((unit) => unit.id === 'app-buyer'));
  const plan = buildPullRequestPlan(
    paths,
    [paths[2] ?? ''],
    REVIEW_VALUES.HEAD,
    REVIEW_VALUES.BASE,
  );
  for (const reviewer of [
    REVIEWER_IDS.SECURITY,
    REVIEWER_IDS.ARCHITECTURE,
    REVIEWER_IDS.BEHAVIOR,
    REVIEWER_IDS.PAYMENTS,
    REVIEWER_IDS.RECOVERY,
    REVIEWER_IDS.PROTOCOL,
  ])
    assert.ok(
      plan.tasks.some((task) => task.reviewer === reviewer),
      reviewer,
    );
});
void test('strict response validation rejects empty evidence, verdict fabrication and severity', () => {
  const bundle: SourceBundle = {
    files: [{ path: FILE, revision: REVIEW_VALUES.HEAD, text: 'code' }],
    diff: '',
    omissions: [],
  };
  assert.throws(
    () =>
      parseReviewResponse(
        JSON.stringify(
          hunter(bundle, REVIEWER_IDS.SECURITY, [{ ...FINDING, evidence: [] }]),
        ),
      ),
    /Evidence/,
  );
  assert.throws(
    () => parseVerificationResponse(JSON.stringify({ decision: 'confirmed' })),
    /properties|Source-only/,
  );
  const record = {
    decision: REVIEW_VALUES.NEEDS_VALIDATION,
    fingerprint: 'a',
    reason: 'source',
    evidence: [EVIDENCE],
    blockers: ['reproduction missing'],
    validation_plan: 'synthetic test',
    severity: 'critical',
  };
  assert.throws(
    () => parseVerificationResponse(JSON.stringify(record)),
    /unexpected/,
  );
});
void test('coverage and evidence must match actual supplied files and line bounds', () => {
  const bundle: SourceBundle = {
    files: [{ path: FILE, revision: REVIEW_VALUES.HEAD, text: 'code' }],
    diff: '',
    omissions: [],
  };
  assert.throws(
    () => validateEvidence([{ ...EVIDENCE, line: 2 }], bundle),
    /unavailable/,
  );
  assert.throws(
    () =>
      validateEvidence([{ ...EVIDENCE, revision: REVIEW_VALUES.BASE }], bundle),
    /unavailable/,
  );
  const response = parseReviewResponse(JSON.stringify(hunter(bundle)));
  response.coverage.reviewed_paths = [];
  assert.throws(() => validateCoverage(response, bundle), /coverage/);
});
void test('Git inventory and bundles use the requested immutable revision and real diff', async () => {
  await fixture(async (root) => {
    const base = await repositoryRef(root);
    await writeFile(join(root, FILE), 'export const limit = 2;\n');
    await exec('git', ['add', '.'], { cwd: root });
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'changed',
      ],
      { cwd: root },
    );
    const head = await repositoryRef(root);
    assert.deepEqual(await trackedFiles(root, base), [FILE]);
    assert.deepEqual(await changedFiles(root, base, head), [FILE]);
    const plan = buildPullRequestPlan([FILE], [FILE], head, base);
    const bundle = await createSourceBundle(root, plan, [FILE]);
    assert.equal(bundle.omissions.length, 0);
    assert.match(bundle.diff, /-export const limit = 1/);
    assert.match(bundle.diff, /\+export const limit = 2/);
    assert.equal(bundle.files.length, 2);
    assert.match((await trackedFile(root, base, FILE)) ?? '', /limit = 1/);
  });
});
void test('dry run never invokes Pi and reports no audit completion', async () => {
  await fixture(async (root, output) => {
    const plan = buildBaselinePlan([FILE], await repositoryRef(root));
    const result = await runReview(plan, {
      root,
      output,
      thinking: 'high',
      dryRun: true,
      execute: async () => {
        throw new Error('must not call');
      },
    });
    assert.equal(result.status, REVIEW_VALUES.NOT_RUN);
  });
});
void test('mock Pi completes the source loop with bounded input and fresh private homes', async () => {
  await fixture(async (root, output) => {
    const plan = buildBaselinePlan([FILE], await repositoryRef(root));
    const homes = new Set<string>();
    const result = await runReview(plan, {
      root,
      output,
      model: 'openai/example',
      thinking: 'high',
      dryRun: false,
      execute: async (options) => {
        homes.add(options.cwd);
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        const bundle = JSON.parse(
          options.prompt.split('Untrusted source bundle (JSON):\n')[1] ?? '',
        );
        const reviewer = Object.values(REVIEWER_IDS).find(
          (id) => id === options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1],
        );
        return success(hunter(bundle, reviewer));
      },
    });
    assert.equal(result.status, REVIEW_VALUES.CLEAN);
    assert.equal(homes.size, plan.tasks.length);
    assert.deepEqual(await readdir(output), []);
    const final = await writeArtifacts(result, { output });
    assert.equal(final.findingsValidation, REVIEW_VALUES.PASSED);
    assert.equal(await readFile(join(output, 'status.txt'), 'utf8'), 'clean\n');
    assert.ok((await readdir(output)).includes('coverage-ledger.json'));
  });
});
void test('pending empty hunter output never becomes clean', async () => {
  await fixture(async (root, output) => {
    const plan = buildBaselinePlan([FILE], await repositoryRef(root));
    const result = await runReview(plan, {
      root,
      output,
      model: 'openai/example',
      thinking: 'high',
      dryRun: false,
      execute: async (options) => {
        const bundle = JSON.parse(
          options.prompt.split('Untrusted source bundle (JSON):\n')[1] ?? '',
        );
        return success({
          ...hunter(
            bundle,
            Object.values(REVIEWER_IDS).find(
              (id) => id === options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1],
            ),
          ),
          status: REVIEW_VALUES.PENDING,
        });
      },
    });
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      REVIEW_VALUES.PENDING,
    );
  });
});
void test('budget exhaustion leaves skipped assignments visible', async () => {
  await fixture(async (root, output) => {
    const result = await runReview(
      buildBaselinePlan([FILE], await repositoryRef(root)),
      {
        root,
        output,
        model: 'openai/example',
        thinking: 'high',
        dryRun: false,
        maxCalls: 1,
        execute: async () => {
          throw new Error('budget must reserve verification');
        },
      },
    );
    assert.ok(
      result.tasks.every((task) => task.status === REVIEW_VALUES.SKIPPED),
    );
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      REVIEW_VALUES.PENDING,
    );
  });
});
void test('a source candidate receives two fresh independent verifiers', async () => {
  await fixture(async (root, output) => {
    let verifiers = 0;
    const result = await runReview(
      buildBaselinePlan([FILE], await repositoryRef(root)),
      {
        root,
        output,
        model: 'openai/example',
        thinking: 'high',
        dryRun: false,
        execute: async (options) => {
          if (options.prompt.includes('fresh independent verifier')) {
            verifiers += 1;
            return success({
              decision: REVIEW_VALUES.NEEDS_VALIDATION,
              fingerprint: FINDING.fingerprint,
              reason: 'Source supports the boundary hypothesis.',
              evidence: [EVIDENCE],
              blockers: ['A synthetic execution is required.'],
              validation_plan: 'Build a bounded policy fixture.',
            });
          }
          const bundle = JSON.parse(
            options.prompt.split('Untrusted source bundle (JSON):\n')[1] ?? '',
          );
          const reviewer = Object.values(REVIEWER_IDS).find(
            (id) => id === options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1],
          );
          return success(
            hunter(
              bundle,
              reviewer,
              reviewer === REVIEWER_IDS.SECURITY ? [FINDING] : [],
            ),
          );
        },
      },
    );
    assert.equal(verifiers, 2);
    assert.equal(result.execution?.callsStarted, result.tasks.length + 2);
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      REVIEW_VALUES.PENDING,
    );
  });
});
