// Owns conservative status and fixed labels; coverage gaps cannot yield a clean review.
import { REVIEW_LABELS, REVIEW_VALUES, type ReviewLabel } from './constants';
import type { ReviewStatus, TaskResult } from './types';

export function overallReviewStatus(results: TaskResult[]): ReviewStatus {
  if (!results.length) return REVIEW_VALUES.NOT_RUN;
  if (results.some((result) => result.status === REVIEW_VALUES.ERROR))
    return REVIEW_VALUES.ERROR;
  if (
    results.some(
      (result) =>
        result.status !== REVIEW_VALUES.COMPLETE || result.findings.length,
    )
  )
    return REVIEW_VALUES.PENDING;
  return REVIEW_VALUES.CLEAN;
}
export function labelsForStatus(status: ReviewStatus): ReviewLabel[] {
  if (status === REVIEW_VALUES.CLEAN) return [REVIEW_LABELS.CLEAN];
  if (status === REVIEW_VALUES.PENDING) return [REVIEW_LABELS.NEEDS_VALIDATION];
  return [REVIEW_LABELS.ERROR];
}
