// Owns source-review reports and coverage. Only deterministic summaries may be published to GitHub.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseVerificationResponse } from './parsing';
import { labelsForStatus, overallReviewStatus } from './result';
import type { ReviewRunResult, ReviewStatus } from './types';

export interface ArtifactOptions {
  output: string;
  trustedRoot?: string;
}
function finalStatus(result: ReviewRunResult): ReviewStatus {
  if (result.status === 'not-run') return 'not-run';
  const status = overallReviewStatus(result.tasks);
  if (status === 'error') return 'error';
  if (
    result.candidates.length !== result.verifications.length ||
    result.verifications.some((item) => item.decision === 'error')
  )
    return 'error';
  if (
    status === 'needs-validation' &&
    result.tasks.some((item) => item.status !== 'complete')
  )
    return 'needs-validation';
  if (result.verifications.some((item) => item.decision === 'needs_validation'))
    return 'needs-validation';
  return status === 'not-run' ? 'not-run' : 'clean';
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;');
}
function renderReport(result: ReviewRunResult): string {
  const lines = [
    '# Gyblos source review',
    '',
    'Status: ' + result.status,
    'Commit: ' + result.sourceRef,
    'Mode: ' + result.mode,
    '',
    'This is a partial source-only AI review, not proof that the protocol is secure.',
    'No target code was executed. Runtime claims require bounded synthetic validation.',
    'No prior run suppressed current coverage. Binary/private/oversized files are excluded or blocked.',
    '',
    '## Coverage',
    '',
    ...result.tasks.map(
      (task) => '- ' + escape(task.taskId) + ': ' + task.status,
    ),
    '',
    '## Excluded paths',
    '',
    ...result.plan.excludedFiles.map((path) => '- ' + escape(path)),
    '',
    '## Independently checked candidates',
    '',
  ];
  for (const candidate of result.candidates) {
    const verification = result.verifications.find(
      (item) => item.fingerprint === candidate.fingerprint,
    );
    lines.push(
      '### ' + escape(candidate.title),
      '',
      'Category: ' + candidate.category,
      'Decision: ' + (verification?.decision ?? 'unvalidated'),
      escape(candidate.description),
      ...candidate.evidence.map(
        (item) =>
          '- ' +
          escape(item.file) +
          ':' +
          item.line +
          ' (' +
          item.revision +
          ')',
      ),
      'Next: ' +
        escape(
          verification?.record?.validation_plan ??
            'Independent validation is incomplete.',
        ),
      '',
    );
  }
  return lines.join('\n') + '\n';
}
export async function writeArtifacts(
  initial: ReviewRunResult,
  options: ArtifactOptions,
): Promise<ReviewRunResult> {
  let validation: 'passed' | 'failed' = 'passed';
  for (const verification of initial.verifications) {
    if (verification.record) {
      try {
        const record = parseVerificationResponse(
          JSON.stringify(verification.record),
        );
        if (
          record.fingerprint !== verification.fingerprint ||
          record.decision !== verification.decision
        )
          validation = 'failed';
      } catch {
        validation = 'failed';
      }
    } else if (verification.decision !== 'error') validation = 'failed';
  }
  const result: ReviewRunResult = {
    ...initial,
    status: validation === 'failed' ? 'error' : finalStatus(initial),
    findingsValidation: initial.status === 'not-run' ? 'not-run' : validation,
  };
  const findings = result.verifications.flatMap((item) =>
    item.record ? [item.record] : [],
  );
  const artifacts: Record<string, string> = {
    'review-results.json': JSON.stringify(result, null, 2),
    'findings.json': JSON.stringify(findings, null, 2),
    'coverage-ledger.json': JSON.stringify(
      {
        sourceRef: result.sourceRef,
        units: result.plan.unitCount,
        excludedFiles: result.plan.excludedFiles,
        tasks: result.tasks,
      },
      null,
      2,
    ),
    'REPORT.md': renderReport(result),
    'status.txt': result.status + '\n',
    'labels.txt': labelsForStatus(result.status).join('\n') + '\n',
  };
  for (const [name, content] of Object.entries(artifacts))
    await writeFile(join(options.output, name), content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  return result;
}
