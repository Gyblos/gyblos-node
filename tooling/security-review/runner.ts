// Owns independent review sessions and a strict invocation budget; target code is never executed.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_MAX_CALLS,
  DEFAULT_REVIEW_CONCURRENCY,
  REVIEW_RESULT_VERSION,
  REVIEW_VALUES,
  type PiThinkingLevel,
} from './constants';
import {
  parseReviewResponse,
  parseVerificationResponse,
  validateCoverage,
  validateEvidence,
} from './parsing';
import { runPi, type RunPiOptions } from './pi';
import { createSourceBundle, partitionBundle } from './projection';
import { attachSource, buildVerificationPrompt } from './prompts';
import { overallReviewStatus } from './result';
import type {
  AgentFinding,
  ReviewPlan,
  ReviewRunResult,
  ReviewTask,
  SourceBundle,
  TaskResult,
  VerificationResponse,
  VerificationResult,
} from './types';

export interface ReviewExecutionOptions {
  root: string;
  output: string;
  model?: string;
  thinking: PiThinkingLevel;
  concurrency?: number;
  maxCalls?: number;
  piCommand?: string;
  dryRun: boolean;
  execute?: typeof runPi;
  policyContext?: string;
}
interface Assignment {
  task: ReviewTask;
  bundle: SourceBundle;
}
interface Execution {
  assignment: Assignment;
  result: TaskResult;
  findings: AgentFinding[];
}
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        const item = items[current];
        if (item !== undefined) results[current] = await work(item);
      }
    }),
  );
  return results;
}
function environment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: directory,
    TMPDIR: join(directory, 'tmp'),
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    PI_CODING_AGENT_DIR: join(directory, 'pi'),
    ...(process.env.OPENAI_API_KEY === undefined
      ? {}
      : { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
  };
}
async function ask(
  prompt: string,
  options: ReviewExecutionOptions,
): Promise<string> {
  const directory = await mkdtemp(join(options.output, 'session-'));
  try {
    for (const name of ['tmp', 'config', 'cache', 'pi'])
      await mkdir(join(directory, name));
    const invocation: RunPiOptions = {
      command: options.piCommand,
      cwd: directory,
      env: environment(directory),
      model: options.model ?? '',
      thinking: options.thinking,
      prompt: (options.policyContext ?? '') + '\n' + prompt,
    };
    const result = await (options.execute ?? runPi)(invocation);
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.truncated ||
      result.timedOut
    )
      throw new Error(
        'Pi invocation failed, timed out or exceeded its output limit.',
      );
    return result.stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function failed(assignment: Assignment, reason: string): Execution {
  return {
    assignment,
    findings: [],
    result: {
      taskId: assignment.task.id,
      status: REVIEW_VALUES.ERROR,
      findings: [],
      error: reason,
      omissions: assignment.bundle.omissions,
    },
  };
}
async function review(
  assignment: Assignment,
  options: ReviewExecutionOptions,
): Promise<Execution> {
  if (assignment.bundle.omissions.length)
    return failed(
      assignment,
      'Source omitted; see coverage ledger. Narrow the input or review the excluded file manually.',
    );
  try {
    const response = parseReviewResponse(
      await ask(
        attachSource(assignment.task.prompt, assignment.bundle),
        options,
      ),
    );
    if (response.reviewer !== assignment.task.reviewer)
      throw new Error('reviewer mismatch');
    validateCoverage(response, assignment.bundle);
    return {
      assignment,
      findings: response.findings,
      result: {
        taskId: assignment.task.id,
        status: response.status,
        coverage: response.coverage.reviewed_paths,
        findings: response.findings.map(({ fingerprint, title }) => ({
          fingerprint,
          title,
        })),
      },
    };
  } catch {
    return failed(
      assignment,
      'Pi output failed invocation, schema, evidence or coverage validation.',
    );
  }
}
function candidatesFrom(
  executions: Execution[],
): { candidate: AgentFinding; assignment: Assignment }[] {
  const selected = new Map<
    string,
    { candidate: AgentFinding; assignment: Assignment }
  >();
  for (const execution of executions)
    for (const candidate of execution.findings) {
      // Preserve distinct reports with colliding fingerprints by including the source claim.
      const key = JSON.stringify(candidate);
      if (!selected.has(key))
        selected.set(key, { candidate, assignment: execution.assignment });
    }
  return [...selected.values()];
}
async function verify(
  candidate: AgentFinding,
  assignment: Assignment,
  options: ReviewExecutionOptions,
): Promise<VerificationResult> {
  try {
    const response = parseVerificationResponse(
      await ask(
        attachSource(
          buildVerificationPrompt(assignment.task, candidate),
          assignment.bundle,
        ),
        options,
      ),
    );
    if (response.fingerprint !== candidate.fingerprint)
      throw new Error('fingerprint mismatch');
    validateEvidence(response.evidence, assignment.bundle);
    // A second fresh verifier checks a rejection too, preventing a single refuter from hiding a lead.
    const final = parseVerificationResponse(
      await ask(
        attachSource(
          buildVerificationPrompt(assignment.task, candidate),
          assignment.bundle,
        ),
        options,
      ),
    );
    validateEvidence(final.evidence, assignment.bundle);
    if (final.fingerprint !== candidate.fingerprint)
      throw new Error('fingerprint mismatch');
    const record: VerificationResponse =
      final.decision === response.decision
        ? final
        : {
            ...final,
            decision: REVIEW_VALUES.NEEDS_VALIDATION,
            blockers: [
              'Independent verifiers disagree; maintainer validation required.',
            ],
            validation_plan:
              'Reconstruct the cited boundary with a synthetic regression before assigning a final verdict.',
          };
    return {
      fingerprint: candidate.fingerprint,
      decision: record.decision,
      record,
    };
  } catch {
    return {
      fingerprint: candidate.fingerprint,
      decision: REVIEW_VALUES.ERROR,
      error:
        'Independent verification failed schema, source or invocation checks.',
    };
  }
}
async function assignmentsFor(
  plan: ReviewPlan,
  options: ReviewExecutionOptions,
): Promise<Assignment[]> {
  const bundles = new Map<string, SourceBundle[]>();
  const assignments: Assignment[] = [];
  for (const task of plan.tasks) {
    let parts = bundles.get(task.unit.id);
    if (!parts) {
      parts = partitionBundle(
        await createSourceBundle(options.root, plan, task.unit.paths),
      );
      bundles.set(task.unit.id, parts);
    }
    for (const [index, bundle] of parts.entries())
      assignments.push({
        task: { ...task, id: task.id + ':' + String(index + 1) },
        bundle,
      });
  }
  return assignments;
}
function validateOptions(options: ReviewExecutionOptions): {
  concurrency: number;
  maxCalls: number;
} {
  const concurrency = options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1
  )
    throw new Error('Invalid execution budget.');
  if (
    !options.dryRun &&
    (!options.model || !options.model.startsWith('openai/'))
  )
    throw new Error('An explicit openai/<model-id> is required.');
  return { concurrency, maxCalls };
}
export async function runReview(
  plan: ReviewPlan,
  options: ReviewExecutionOptions,
): Promise<ReviewRunResult> {
  const { concurrency, maxCalls } = validateOptions(options);
  await mkdir(options.output, { recursive: true });
  const summary = {
    taskCount: plan.tasks.length,
    unitCount: plan.units.length,
    reviewers: [...new Set(plan.tasks.map((task) => task.reviewer))].sort(),
    changedFiles: plan.changedFiles,
    excludedFiles: plan.excludedFiles,
  };
  const result: ReviewRunResult = {
    version: REVIEW_RESULT_VERSION,
    mode: plan.mode,
    sourceRef: plan.sourceRef,
    ...(plan.baseRef ? { baseRef: plan.baseRef } : {}),
    status: REVIEW_VALUES.NOT_RUN,
    plan: summary,
    candidates: [],
    tasks: [],
    verifications: [],
    findingsValidation: REVIEW_VALUES.NOT_RUN,
    execution: {
      model: options.model ?? null,
      thinking: options.thinking,
      maxCalls,
      callsStarted: 0,
    },
  };
  if (options.dryRun) return result;
  const execution = result.execution;
  const countedOptions: ReviewExecutionOptions = {
    ...options,
    execute: async (invocation) => {
      if (!execution || execution.callsStarted >= maxCalls)
        throw new Error('Invocation budget exhausted.');
      execution.callsStarted += 1;
      return (options.execute ?? runPi)(invocation);
    },
  };
  const assignments = await assignmentsFor(plan, options);
  summary.taskCount = assignments.length;
  // Reserve at least two independent verification calls before spending on hunters.
  const allowance = Math.max(0, maxCalls - 2);
  const executions = await mapConcurrent(
    assignments.slice(0, allowance),
    concurrency,
    (assignment) => review(assignment, countedOptions),
  );
  const deferred: TaskResult[] = assignments
    .slice(allowance)
    .map(({ task }) => ({
      taskId: task.id,
      status: REVIEW_VALUES.SKIPPED,
      findings: [],
      error: 'Invocation budget exhausted.',
    }));
  let remaining = maxCalls - Math.min(assignments.length, allowance);
  const verifications: VerificationResult[] = [];
  const candidates = candidatesFrom(executions);
  for (const { candidate, assignment } of candidates) {
    if (remaining < 2) {
      verifications.push({
        fingerprint: candidate.fingerprint,
        decision: REVIEW_VALUES.ERROR,
        error: 'Invocation budget cannot fund both independent verifiers.',
      });
      continue;
    }
    remaining -= 2;
    verifications.push(await verify(candidate, assignment, countedOptions));
  }
  result.candidates = candidates.map((item) => item.candidate);
  result.tasks = [...executions.map((item) => item.result), ...deferred];
  result.verifications = verifications;
  result.status = overallReviewStatus(result.tasks);
  return result;
}
