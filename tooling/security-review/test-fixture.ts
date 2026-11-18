// Shared synthetic Git repository and Pi responses for source review tests.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { REVIEW_VALUES, REVIEWER_IDS, type ReviewerId } from './constants';
import type {
  AgentEvidence,
  AgentFinding,
  PiProcessResult,
  SourceBundle,
} from './types';

export const exec = promisify(execFile);
export const FILE = 'packages/core/src/policy.ts';
export const EVIDENCE: AgentEvidence = {
  file: FILE,
  revision: REVIEW_VALUES.HEAD,
  line: 1,
  scope: 'policy',
  description: 'Source rule.',
};
export const FINDING: AgentFinding = {
  fingerprint: 'policy:boundary',
  category: REVIEW_VALUES.SECURITY,
  title: 'Candidate',
  description: 'Source hypothesis.',
  evidence: [EVIDENCE],
  lower_trust_principal: 'untrusted peer',
  affected_resource: 'policy',
  observed_result: 'Source inference.',
  suggested_fix: 'Add the invariant at admission.',
};
export function hunter(
  bundle: SourceBundle,
  reviewer: ReviewerId = REVIEWER_IDS.SECURITY,
  findings: AgentFinding[] = [],
) {
  return {
    status: REVIEW_VALUES.COMPLETE,
    reviewer,
    coverage: {
      reviewed_paths: [...new Set(bundle.files.map((file) => file.path))],
      notes: 'Source checked.',
    },
    findings,
  };
}
export function success(value: unknown): PiProcessResult {
  return {
    exitCode: 0,
    signal: null,
    truncated: false,
    timedOut: false,
    stdout: JSON.stringify(value),
  };
}
export async function fixture(
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
