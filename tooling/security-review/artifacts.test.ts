// Owns conservative report association regressions using isolated synthetic results.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeArtifacts } from './artifacts';
import { REVIEW_VALUES, REVIEWER_IDS } from './constants';
import type {
  AgentFinding,
  ReviewRunResult,
  VerificationResponse,
} from './types';

function result(): ReviewRunResult {
  return {
    version: 1,
    mode: REVIEW_VALUES.PR,
    sourceRef: 'a'.repeat(40),
    status: REVIEW_VALUES.CLEAN,
    plan: {
      taskCount: 1,
      unitCount: 1,
      reviewers: [REVIEWER_IDS.SECURITY],
      changedFiles: [],
      excludedFiles: [],
    },
    candidates: [],
    verifications: [],
    findingsValidation: REVIEW_VALUES.NOT_RUN,
    tasks: [{ taskId: 'test', status: REVIEW_VALUES.COMPLETE, findings: [] }],
  };
}
async function withOutput(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-report-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void test('excluded changed paths keep an otherwise completed PR pending', async () => {
  await withOutput(async (output) => {
    const initial = result();
    initial.plan.changedFiles = ['packages/core/internal/policy.ts'];
    initial.plan.excludedFiles = [...initial.plan.changedFiles];
    assert.equal(
      (await writeArtifacts(initial, { output })).status,
      REVIEW_VALUES.PENDING,
    );
  });
});

void test('a changed binary a task excluded keeps the PR pending; an unchanged one does not', async () => {
  for (const [changed, expected] of [
    [['docs/logo.png'], REVIEW_VALUES.PENDING],
    [['packages/core/src/policy.ts'], REVIEW_VALUES.CLEAN],
  ] as const) {
    await withOutput(async (output) => {
      const initial = result();
      initial.plan.changedFiles = [...changed];
      initial.tasks = [
        {
          taskId: 'test',
          status: REVIEW_VALUES.COMPLETE,
          findings: [],
          excluded: [{ path: 'docs/logo.png', reason: 'binary' }],
        },
      ];
      assert.equal(
        (await writeArtifacts(initial, { output })).status,
        expected,
      );
      assert.match(
        await readFile(join(output, 'REPORT.md'), 'utf8'),
        /## Excluded paths\n\n- docs\/logo\.png/,
      );
    });
  }
});

void test('artifact output refuses to replace an existing run', async () => {
  await withOutput(async (output) => {
    await writeArtifacts(result(), { output });
    await assert.rejects(writeArtifacts(result(), { output }), /EEXIST/);
  });
});
void test('fingerprint collisions retain each positional verification in the report', async () => {
  await withOutput(async (output) => {
    const initial = result();
    const candidate: AgentFinding = {
      fingerprint: 'collision',
      category: REVIEW_VALUES.SECURITY,
      title: 'First candidate',
      description: 'Source hypothesis.',
      evidence: [
        {
          file: 'packages/core/a.ts',
          revision: REVIEW_VALUES.HEAD,
          line: 1,
          scope: 'a',
          description: 'Source.',
        },
      ],
      lower_trust_principal: 'peer',
      affected_resource: 'policy',
      observed_result: 'source only',
      suggested_fix: 'regression',
    };
    const rejected: VerificationResponse = {
      decision: REVIEW_VALUES.REJECTED,
      fingerprint: 'collision',
      reason: 'Refuted.',
      evidence: candidate.evidence,
      blockers: [],
      validation_plan: 'First plan.',
    };
    const pending: VerificationResponse = {
      ...rejected,
      decision: REVIEW_VALUES.NEEDS_VALIDATION,
      blockers: ['Missing fixture.'],
      validation_plan: 'Second plan.',
    };
    initial.candidates = [
      candidate,
      { ...candidate, title: 'Second candidate' },
    ];
    initial.verifications = [
      {
        fingerprint: 'collision',
        decision: REVIEW_VALUES.REJECTED,
        record: rejected,
      },
      {
        fingerprint: 'collision',
        decision: REVIEW_VALUES.NEEDS_VALIDATION,
        record: pending,
      },
    ];
    await writeArtifacts(initial, { output });
    const report = await readFile(join(output, 'REPORT.md'), 'utf8');
    assert.match(
      report,
      /First candidate[\s\S]*Decision: rejected[\s\S]*First plan/,
    );
    assert.match(
      report,
      /Second candidate[\s\S]*Decision: needs_validation[\s\S]*Second plan/,
    );
  });
});
