// Owns conservative status and fixed labels; coverage gaps cannot yield a clean review.
import { REVIEW_LABELS, type ReviewLabel } from './constants';
import type { ReviewStatus, TaskResult } from './types';

export function overallReviewStatus(results: TaskResult[]): ReviewStatus {
  if (!results.length) return 'not-run';
  if (results.some((result) => result.status === 'error')) return 'error';
  if (
    results.some(
      (result) => result.status !== 'complete' || result.findings.length,
    )
  )
    return 'needs-validation';
  return 'clean';
}
export function labelsForStatus(status: ReviewStatus): ReviewLabel[] {
  if (status === 'clean') return [REVIEW_LABELS.CLEAN];
  if (status === 'needs-validation') return [REVIEW_LABELS.NEEDS_VALIDATION];
  return [REVIEW_LABELS.ERROR];
}
