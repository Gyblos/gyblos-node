// Owns independent review sessions and a strict invocation budget; target code is never executed.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_MAX_CALLS,
  DEFAULT_REVIEW_CONCURRENCY,
  REVIEW_FAILURE,
  REVIEW_PHASE,
  REVIEW_RESULT_VERSION,
  REVIEW_VALUES,
  type PiThinkingLevel,
  type ReviewFailure,
} from './constants';
import {
  parseReviewResponse,
  parseVerificationResponse,
  validateCoverage,
  validateEvidence,
} from './parsing';
import { preparePiDirectory, runPi, type RunPiOptions } from './pi';
import { createSourceBundle, partitionBundle } from './projection';
import { attachSource, buildVerificationPrompt } from './prompts';
import { InvocationFailure, providerAdmission } from './provider-admission';
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
    await preparePiDirectory(directory);
    const invocation: RunPiOptions = {
      command: options.piCommand,
      cwd: directory,
      env: environment(directory),
      model: options.model ?? '',
      thinking: options.thinking,
      prompt: (options.policyContext ?? '') + '\n' + prompt,
    };
    const result = await (options.execute ?? runPi)(invocation);
    if (result.timedOut) throw new InvocationFailure(REVIEW_FAILURE.TIMEOUT);
    if (result.truncated) throw new InvocationFailure(REVIEW_FAILURE.LIMIT);
    if (result.failure) throw new InvocationFailure(result.failure);
    if (result.exitCode !== 0 || result.signal)
      throw new InvocationFailure(REVIEW_FAILURE.PI);
    return result.stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function excludedOf(assignment: Assignment) {
  return assignment.bundle.excluded.length
    ? { excluded: assignment.bundle.excluded }
    : {};
}
function failed(
  assignment: Assignment,
  failure: ReviewFailure,
  skipped = false,
): Execution {
  return {
    assignment,
    findings: [],
    result: {
      taskId: assignment.task.id,
      status: skipped ? REVIEW_VALUES.SKIPPED : REVIEW_VALUES.ERROR,
      findings: [],
      failure,
      omissions: assignment.bundle.omissions,
      ...excludedOf(assignment),
    },
  };
}
async function review(
  assignment: Assignment,
  options: ReviewExecutionOptions,
): Promise<Execution> {
  if (assignment.bundle.omissions.length)
    return failed(assignment, REVIEW_FAILURE.SOURCE);
  let phase: ReviewFailure = REVIEW_FAILURE.PI;
  try {
    const output = await ask(
      attachSource(assignment.task.prompt, assignment.bundle),
      options,
    );
    phase = REVIEW_FAILURE.FORMAT;
    const response = parseReviewResponse(output);
    if (response.reviewer !== assignment.task.reviewer)
      throw new Error('reviewer mismatch');
    phase = REVIEW_FAILURE.COVERAGE;
    validateCoverage(response, assignment.bundle);
    return {
      assignment,
      findings: response.findings,
      result: {
        taskId: assignment.task.id,
        status: response.status,
        coverage: response.coverage.reviewed_paths,
        ...excludedOf(assignment),
        findings: response.findings.map(({ fingerprint, title }) => ({
          fingerprint,
          title,
        })),
      },
    };
  } catch (error) {
    return error instanceof InvocationFailure
      ? failed(assignment, error.code, error.skipped)
      : failed(assignment, phase);
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
  let pass: NonNullable<VerificationResult['failedPass']> =
    REVIEW_PHASE.VERIFY_FIRST;
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
    pass = REVIEW_PHASE.VERIFY_SECOND;
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
  } catch (error) {
    return {
      fingerprint: candidate.fingerprint,
      decision: REVIEW_VALUES.ERROR,
      failedPass: pass,
      failure:
        error instanceof InvocationFailure ? error.code : REVIEW_FAILURE.VERIFY,
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
  const { admission, execute } = providerAdmission(
    options.execute ?? runPi,
    result.execution,
  );
  const countedOptions = { ...options, execute };
  const assignments = await assignmentsFor(plan, options);
  summary.taskCount = assignments.length;
  // Reserve at least two independent verification calls before spending on hunters.
  const allowance = Math.max(0, maxCalls - 2);
  const executions = await mapConcurrent(
    assignments.slice(0, allowance),
    concurrency,
    (assignment) =>
      admission.stopped
        ? Promise.resolve(failed(assignment, admission.stopped, true))
        : review(assignment, countedOptions),
  );
  const deferred: TaskResult[] = assignments
    .slice(allowance)
    .map(({ task }) => ({
      taskId: task.id,
      status: REVIEW_VALUES.SKIPPED,
      findings: [],
      failure: REVIEW_FAILURE.BUDGET,
    }));
  let remaining = maxCalls - Math.min(assignments.length, allowance);
  const verifications: VerificationResult[] = [];
  const candidates = candidatesFrom(executions);
  for (const { candidate, assignment } of candidates) {
    if (admission.stopped || remaining < 2) {
      verifications.push({
        fingerprint: candidate.fingerprint,
        decision: REVIEW_VALUES.ERROR,
        failure: admission.stopped ?? REVIEW_FAILURE.BUDGET,
      });
      continue;
    }
    remaining -= 2;
    verifications.push(await verify(candidate, assignment, countedOptions));
  }
  result.candidates = candidates.map((item) => item.candidate);
  result.tasks = [...executions.map((item) => item.result), ...deferred];
  result.verifications = verifications;
  result.status = overallReviewStatus(result.tasks, verifications);
  return result;
}
