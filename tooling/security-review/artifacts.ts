// Owns source-review reports and coverage. Only deterministic summaries may be published to GitHub.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REVIEW_FAILURE, REVIEW_PHASE, REVIEW_VALUES } from './constants';
import { parseVerificationResponse } from './parsing';
import { labelsForStatus, overallReviewStatus } from './result';
import type { ReviewRunResult, ReviewStatus } from './types';

export interface ArtifactOptions {
  output: string;
}
function finalStatus(result: ReviewRunResult): ReviewStatus {
  if (result.status === REVIEW_VALUES.NOT_RUN) return REVIEW_VALUES.NOT_RUN;
  if (result.status === REVIEW_VALUES.ERROR) return REVIEW_VALUES.ERROR;
  const status = overallReviewStatus(result.tasks);
  if (status === REVIEW_VALUES.ERROR) return REVIEW_VALUES.ERROR;
  if (
    result.candidates.length !== result.verifications.length ||
    result.candidates.some(
      (candidate, index) =>
        result.verifications[index]?.fingerprint !== candidate.fingerprint,
    ) ||
    result.verifications.some((item) => item.decision === REVIEW_VALUES.ERROR)
  )
    return REVIEW_VALUES.ERROR;
  if (
    result.plan.changedFiles.some((path) =>
      result.plan.excludedFiles.includes(path),
    )
  )
    return REVIEW_VALUES.PENDING;
  if (
    status === REVIEW_VALUES.PENDING &&
    result.tasks.some((item) => item.status !== REVIEW_VALUES.COMPLETE)
  )
    return REVIEW_VALUES.PENDING;
  if (
    result.verifications.some(
      (item) => item.decision === REVIEW_VALUES.NEEDS_VALIDATION,
    )
  )
    return REVIEW_VALUES.PENDING;
  return status === REVIEW_VALUES.NOT_RUN
    ? REVIEW_VALUES.NOT_RUN
    : REVIEW_VALUES.CLEAN;
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
  for (const [index, candidate] of result.candidates.entries()) {
    const verification = result.verifications[index];
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
function diagnosticSummary(result: ReviewRunResult): string {
  return (
    [
      result.execution?.callsStarted ?? 0,
      result.execution?.reportedTokens ?? 'unknown',
      ...new Set([
        ...result.tasks.flatMap((item) => {
          if (!item.failure) return [];
          if (item.failure === REVIEW_FAILURE.BUDGET)
            return [REVIEW_PHASE.SCHEDULE + ' ' + item.failure];
          return item.status === REVIEW_VALUES.ERROR
            ? [REVIEW_PHASE.REVIEW + ' ' + item.failure]
            : [];
        }),
        ...result.verifications.flatMap((item) => {
          if (item.failedPass && item.failure)
            return [item.failedPass + ' ' + item.failure];
          return item.failure === REVIEW_FAILURE.BUDGET
            ? [REVIEW_PHASE.SCHEDULE + ' ' + item.failure]
            : [];
        }),
      ]),
    ].join('\n') + '\n'
  );
}
export async function writeArtifacts(
  initial: ReviewRunResult,
  options: ArtifactOptions,
): Promise<ReviewRunResult> {
  let validation: ReviewRunResult['findingsValidation'] = REVIEW_VALUES.PASSED;
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
          validation = REVIEW_VALUES.FAILED;
      } catch {
        validation = REVIEW_VALUES.FAILED;
      }
    } else if (verification.decision !== REVIEW_VALUES.ERROR)
      validation = REVIEW_VALUES.FAILED;
  }
  const result: ReviewRunResult = {
    ...initial,
    status:
      validation === REVIEW_VALUES.FAILED
        ? REVIEW_VALUES.ERROR
        : finalStatus(initial),
    findingsValidation:
      initial.status === REVIEW_VALUES.NOT_RUN
        ? REVIEW_VALUES.NOT_RUN
        : validation,
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
    'diagnostics.txt': diagnosticSummary(result),
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
