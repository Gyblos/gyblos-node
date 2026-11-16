// Owns deterministic reviewer routing; it must not use model output to decide security coverage.
import { REVIEWER_IDS, type ReviewerId } from './constants';
import {
  buildReviewUnits,
  changedPathMatchesUnit,
  reviewableFiles,
} from './inventory';
import { buildReviewPrompt } from './prompts';
import type { ReviewMode, ReviewPlan, ReviewTask, ReviewUnit } from './types';

const BASE_REVIEWERS: ReviewerId[] = [
  REVIEWER_IDS.SECURITY,
  REVIEWER_IDS.ARCHITECTURE,
  REVIEWER_IDS.BEHAVIOR,
];

const REVIEWER_ORDER: ReviewerId[] = [
  REVIEWER_IDS.SECURITY,
  REVIEWER_IDS.PROTOCOL,
  REVIEWER_IDS.PAYMENTS,
  REVIEWER_IDS.NETWORK,
  REVIEWER_IDS.RECOVERY,
  REVIEWER_IDS.DESKTOP,
  REVIEWER_IDS.SUPPLY_CHAIN,
  REVIEWER_IDS.ARCHITECTURE,
  REVIEWER_IDS.BEHAVIOR,
  REVIEWER_IDS.TESTS,
];

function reviewersForUnit(unit: ReviewUnit): ReviewerId[] {
  const reviewers = new Set<ReviewerId>(BASE_REVIEWERS);
  const paths = unit.paths;

  if (paths.some((path) => path.startsWith('packages/protocol/')))
    reviewers.add(REVIEWER_IDS.PROTOCOL);
  if (
    paths.some(
      (path) =>
        path.startsWith('packages/payments-') ||
        path.startsWith('packages/x402-') ||
        path.includes('/payment') ||
        path.includes('/recovery'),
    )
  ) {
    reviewers.add(REVIEWER_IDS.PAYMENTS);
    reviewers.add(REVIEWER_IDS.RECOVERY);
  }
  if (
    paths.some(
      (path) =>
        path.startsWith('packages/transport-') ||
        path.startsWith('packages/identity/') ||
        path.startsWith('packages/discovery-') ||
        path.startsWith('apps/discovery-index/'),
    )
  )
    reviewers.add(REVIEWER_IDS.NETWORK);
  if (paths.some((path) => path.startsWith('apps/desktop/')))
    reviewers.add(REVIEWER_IDS.DESKTOP);
  if (
    paths.some(
      (path) =>
        path.startsWith('.github/') ||
        path.startsWith('tooling/') ||
        ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(
          path,
        ),
    )
  )
    reviewers.add(REVIEWER_IDS.SUPPLY_CHAIN);
  if (paths.some((path) => /(^|\/)(?:test|tests)(?:\/|\.)/.test(path)))
    reviewers.add(REVIEWER_IDS.TESTS);

  return REVIEWER_ORDER.filter((reviewer) => reviewers.has(reviewer));
}

function taskFor(
  mode: ReviewMode,
  unit: ReviewUnit,
  reviewer: ReviewerId,
  changedFiles: string[],
): ReviewTask {
  const task: ReviewTask = {
    id: `${reviewer}:${unit.id}`,
    reviewer,
    unit,
    prompt: '',
  };
  task.prompt = buildReviewPrompt(mode, task, changedFiles);
  return task;
}

function plan(
  mode: ReviewMode,
  files: string[],
  changedFiles: string[],
  sourceRef: string,
  baseRef: string | undefined,
): ReviewPlan {
  const safeFiles = reviewableFiles([...files, ...changedFiles]);
  const excludedFiles = [...new Set([...files, ...changedFiles])]
    .filter((file) => !safeFiles.includes(file))
    .sort();
  const allUnits = buildReviewUnits(safeFiles);
  const selectedUnits =
    mode === 'baseline'
      ? allUnits
      : allUnits.filter((unit) =>
          changedFiles.some((file) => changedPathMatchesUnit(unit, file)),
        );
  const units = [...selectedUnits];
  const coveredChanges = new Set(
    selectedUnits.flatMap((unit) =>
      changedFiles.filter((file) => changedPathMatchesUnit(unit, file)),
    ),
  );
  const uncoveredChanges = reviewableFiles(changedFiles).filter(
    (file) => !coveredChanges.has(file),
  );

  if (uncoveredChanges.length > 0) {
    units.push({
      id: 'pull-request-change',
      label: 'Unmapped pull-request changes',
      kind: 'repository',
      paths: uncoveredChanges,
    });
  }

  const tasks = units.flatMap((unit) =>
    reviewersForUnit(unit).map((reviewer) =>
      taskFor(mode, unit, reviewer, changedFiles),
    ),
  );

  return {
    mode,
    sourceRef,
    ...(baseRef === undefined ? {} : { baseRef }),
    changedFiles: [...changedFiles].sort(),
    excludedFiles,
    units: units.sort((left, right) => left.id.localeCompare(right.id)),
    tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function buildBaselinePlan(
  files: string[],
  sourceRef: string,
): ReviewPlan {
  return plan('baseline', files, [], sourceRef, undefined);
}

export function buildPullRequestPlan(
  files: string[],
  changedFiles: string[],
  sourceRef: string,
  baseRef: string,
): ReviewPlan {
  return plan('pull-request', files, changedFiles, sourceRef, baseRef);
}
