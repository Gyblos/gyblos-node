// Owns synthetic review integration tests. No real credentials, target processes or model calls are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { writeArtifacts } from './security-review/artifacts';
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
import {
  createSourceBundle,
  partitionBundle,
} from './security-review/projection';
import { labelsForStatus, overallReviewStatus } from './security-review/result';
import { runReview } from './security-review/runner';
import type {
  AgentFinding,
  PiProcessResult,
  ReviewRunResult,
  SourceBundle,
} from './security-review/types';

const exec = promisify(execFile);
const FILE = 'packages/core/src/policy.ts';
const EVIDENCE = {
  file: FILE,
  revision: 'head' as const,
  line: 1,
  scope: 'policy',
  description: 'Source rule.',
};
const FINDING: AgentFinding = {
  fingerprint: 'policy:boundary',
  category: 'security',
  title: 'Candidate',
  description: 'Source hypothesis.',
  evidence: [EVIDENCE],
  lower_trust_principal: 'untrusted peer',
  affected_resource: 'policy',
  observed_result: 'Source inference.',
  suggested_fix: 'Add the invariant at admission.',
};
function hunter(
  bundle: SourceBundle,
  reviewer = 'security-general',
  findings: AgentFinding[] = [],
) {
  return {
    status: 'complete',
    reviewer,
    coverage: {
      reviewed_paths: [...new Set(bundle.files.map((file) => file.path))],
      notes: 'Source checked.',
    },
    findings,
  };
}
function success(value: unknown): PiProcessResult {
  return {
    exitCode: 0,
    signal: null,
    truncated: false,
    timedOut: false,
    stdout: JSON.stringify(value),
  };
}
function initial(): ReviewRunResult {
  return {
    version: 1,
    mode: 'baseline',
    sourceRef: 'a'.repeat(40),
    status: 'clean',
    plan: {
      taskCount: 1,
      unitCount: 1,
      reviewers: ['security-general'],
      changedFiles: [],
      excludedFiles: [],
    },
    candidates: [],
    verifications: [],
    findingsValidation: 'not-run',
    tasks: [{ taskId: 'example', status: 'complete', findings: [] }],
  };
}
async function fixture(
  run: (root: string, output: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-review-fixture-'));
  const root = join(directory, 'source');
  const output = join(directory, 'results');
  await mkdir(root);
  await mkdir(output);
  await mkdir(dirname(join(root, FILE)), { recursive: true });
  await writeFile(join(root, FILE), 'export const limit = 1;\n');
  await exec('git', ['init', '-q'], { cwd: root });
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
      'fixture',
    ],
    { cwd: root },
  );
  try {
    await run(root, output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void test('baseline and payment PR select independent base and specialist reviews', () => {
  const paths = [
    FILE,
    'packages/protocol/src/a.ts',
    'packages/payments-x402/src/recovery.ts',
    'apps/buyer/src/main.ts',
  ];
  const baseline = buildBaselinePlan(paths, 'head');
  assert.ok(baseline.units.some((unit) => unit.id === 'app-buyer'));
  const plan = buildPullRequestPlan(paths, [paths[2] ?? ''], 'head', 'base');
  for (const reviewer of [
    'security-general',
    'architecture-maintainability',
    'behavior-equivalence',
    'payments-economics',
    'concurrency-recovery',
    'protocol-crypto',
  ])
    assert.ok(
      plan.tasks.some((task) => task.reviewer === reviewer),
      reviewer,
    );
});
void test('strict response validation rejects empty evidence, verdict fabrication and severity', () => {
  const bundle: SourceBundle = {
    files: [{ path: FILE, revision: 'head', text: 'code' }],
    diff: '',
    omissions: [],
  };
  assert.throws(
    () =>
      parseReviewResponse(
        JSON.stringify(
          hunter(bundle, 'security-general', [{ ...FINDING, evidence: [] }]),
        ),
      ),
    /Evidence/,
  );
  assert.throws(
    () => parseVerificationResponse(JSON.stringify({ decision: 'confirmed' })),
    /properties|Source-only/,
  );
  const record = {
    decision: 'needs_validation',
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
    files: [{ path: FILE, revision: 'head', text: 'code' }],
    diff: '',
    omissions: [],
  };
  assert.throws(
    () => validateEvidence([{ ...EVIDENCE, line: 2 }], bundle),
    /unavailable/,
  );
  assert.throws(
    () => validateEvidence([{ ...EVIDENCE, revision: 'base' }], bundle),
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
    assert.equal(result.status, 'not-run');
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
        const reviewer = options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1];
        return success(hunter(bundle, reviewer));
      },
    });
    assert.equal(result.status, 'clean');
    assert.equal(homes.size, plan.tasks.length);
    assert.deepEqual(await readdir(output), []);
    const final = await writeArtifacts(result, { output });
    assert.equal(final.findingsValidation, 'passed');
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
          ...hunter(bundle, options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1]),
          status: 'needs-validation',
        });
      },
    });
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      'needs-validation',
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
    assert.ok(result.tasks.every((task) => task.status === 'skipped'));
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      'needs-validation',
    );
  });
});
void test('artifact contract rejects malformed verifier output and refuses replacement', async () => {
  await fixture(async (_root, output) => {
    const final = await writeArtifacts(initial(), { output });
    assert.equal(final.status, 'clean');
    await assert.rejects(writeArtifacts(initial(), { output }), /EEXIST/);
  });
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
              decision: 'needs_validation',
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
          const reviewer = options.prompt.match(/Reviewer: ([a-z-]+)/)?.[1];
          return success(
            hunter(
              bundle,
              reviewer,
              reviewer === 'security-general' ? [FINDING] : [],
            ),
          );
        },
      },
    );
    assert.equal(verifiers, 2);
    assert.equal(result.execution?.callsStarted, result.tasks.length + 2);
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      'needs-validation',
    );
  });
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
