// Owns the security-review command entrypoint; it orchestrates read-only analysis and writes only explicit output paths.
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifacts } from './artifacts';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_PI_THINKING,
  type PiThinkingLevel,
} from './constants';
import { changedFiles, repositoryRef, resolveRef, trackedFiles } from './git';
import { buildBaselinePlan, buildPullRequestPlan } from './plan';
import { runReview } from './runner';
import type { CliOptions, ReviewMode } from './types';

const TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const THINKING_LEVELS: PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function usage(): string {
  return [
    'Usage:',
    '  pnpm security-review -- plan baseline [options]',
    '  pnpm security-review -- plan pr --base-ref <sha> [options]',
    '  pnpm security-review -- run baseline --output <dir> [options]',
    '  pnpm security-review -- run pr --base-ref <sha> --output <dir> [options]',
    '',
    'Options:',
    '  --root <dir>          Review this committed checkout.',
    '  --output <dir>        Write artifacts outside the checkout.',
    '  --source-ref <sha>    Git source ref; defaults to HEAD.',
    '  --base-ref <sha>      Git base ref for pull-request mode.',
    '  --model <model>       Pi model; defaults to PI_MODEL.',
    '  --thinking <level>    Pi thinking level; defaults to high.',
    '  --concurrency <n>     Maximum parallel Pi tasks; defaults to 3.',
    '  --dry-run             Build the plan without calling Pi.',
  ].join('\n');
}

function requiredValue(
  argumentsList: string[],
  index: number,
  option: string,
): string {
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`${option} requires a value.`);
  return value;
}

function thinkingLevel(value: string): PiThinkingLevel {
  if (!THINKING_LEVELS.includes(value as PiThinkingLevel))
    throw new Error(`Unsupported thinking level: ${value}`);
  return value as PiThinkingLevel;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${option} must be a positive integer.`);
  return parsed;
}

interface ArgumentState {
  root: string;
  output: string;
  sourceRef?: string;
  baseRef?: string;
  model?: string;
  thinking: PiThinkingLevel;
  concurrency: number;
  maxCalls: number;
  dryRun: boolean;
}

function defaultArgumentState(): ArgumentState {
  return {
    root: process.env.SECURITY_REVIEW_ROOT ?? TOOLING_ROOT,
    output: process.env.SECURITY_REVIEW_OUTPUT ?? '',
    ...(process.env.SECURITY_REVIEW_SOURCE_REF === undefined
      ? {}
      : { sourceRef: process.env.SECURITY_REVIEW_SOURCE_REF }),
    ...(process.env.GITHUB_BASE_SHA === undefined
      ? {}
      : { baseRef: process.env.GITHUB_BASE_SHA }),
    ...(process.env.PI_MODEL === undefined
      ? {}
      : { model: process.env.PI_MODEL }),
    thinking: thinkingLevel(process.env.PI_THINKING ?? DEFAULT_PI_THINKING),
    concurrency: positiveInteger(
      process.env.SECURITY_REVIEW_CONCURRENCY ?? '3',
      '--concurrency',
    ),
    dryRun: false,
    maxCalls: DEFAULT_MAX_CALLS,
  };
}

function applyArgument(
  argumentsList: string[],
  index: number,
  state: ArgumentState,
): number {
  const argument = argumentsList[index];
  if (argument === '--dry-run') {
    state.dryRun = true;
    return index + 1;
  }
  if (argument === '--root') {
    state.root = resolve(
      process.cwd(),
      requiredValue(argumentsList, index, argument),
    );
    return index + 2;
  }
  if (argument === '--output') {
    state.output = resolve(
      process.cwd(),
      requiredValue(argumentsList, index, argument),
    );
    return index + 2;
  }
  if (argument === '--source-ref') {
    state.sourceRef = requiredValue(argumentsList, index, argument);
    return index + 2;
  }
  if (argument === '--base-ref') {
    state.baseRef = requiredValue(argumentsList, index, argument);
    return index + 2;
  }
  if (argument === '--model') {
    state.model = requiredValue(argumentsList, index, argument);
    return index + 2;
  }
  if (argument === '--thinking') {
    state.thinking = thinkingLevel(
      requiredValue(argumentsList, index, argument),
    );
    return index + 2;
  }
  if (argument === '--concurrency') {
    state.concurrency = positiveInteger(
      requiredValue(argumentsList, index, argument),
      argument,
    );
    return index + 2;
  }
  if (argument === '--max-calls') {
    state.maxCalls = positiveInteger(
      requiredValue(argumentsList, index, argument),
      argument,
    );
    return index + 2;
  }
  throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
}

function parseOptions(argumentsList: string[]): CliOptions {
  const command = argumentsList[0];
  if (command !== 'run' && command !== 'plan') throw new Error(usage());
  const modeArgument = argumentsList[1];
  if (
    modeArgument !== 'baseline' &&
    modeArgument !== 'pr' &&
    modeArgument !== 'pull-request'
  )
    throw new Error(usage());
  const mode: ReviewMode =
    modeArgument === 'baseline' ? 'baseline' : 'pull-request';
  const state = defaultArgumentState();
  let index = 2;
  while (index < argumentsList.length)
    index = applyArgument(argumentsList, index, state);

  return {
    command,
    mode,
    ...state,
  };
}

async function createPlan(options: CliOptions) {
  const sourceRef = options.sourceRef
    ? await resolveRef(options.root, options.sourceRef)
    : await repositoryRef(options.root);
  const files = await trackedFiles(options.root, sourceRef);
  if (options.mode === 'baseline') return buildBaselinePlan(files, sourceRef);
  if (options.baseRef === undefined)
    throw new Error(
      'Pull-request mode requires --base-ref or GITHUB_BASE_SHA.',
    );
  const baseRef = await resolveRef(options.root, options.baseRef);
  const changes = await changedFiles(options.root, baseRef, sourceRef);
  return buildPullRequestPlan(files, changes, sourceRef, baseRef);
}

async function validateOutput(options: CliOptions): Promise<void> {
  const root = await realpath(options.root);
  await mkdir(options.output, { recursive: true });
  if ((await lstat(options.output)).isSymbolicLink())
    throw new Error('Output must be a real directory.');
  const output = await realpath(options.output);
  if (
    output === root ||
    output.startsWith(root + '/') ||
    root.startsWith(output + '/')
  )
    throw new Error('Output must be outside the reviewed checkout.');
  if ((await readdir(output)).length)
    throw new Error('Output must be empty; use a new run directory.');
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const options = parseOptions(
    argumentsList[0] === '--' ? argumentsList.slice(1) : argumentsList,
  );
  const plan = await createPlan(options);
  if (options.command === 'plan') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (options.output.length === 0)
    throw new Error('Run mode requires --output or SECURITY_REVIEW_OUTPUT.');
  await validateOutput(options);
  const initial = await runReview(plan, {
    root: options.root,
    output: options.output,
    model: options.model,
    thinking: options.thinking,
    concurrency: options.concurrency,
    maxCalls: options.maxCalls,
    piCommand: process.env.PI_COMMAND,
    dryRun: options.dryRun,
  });
  const result = await writeArtifacts(initial, {
    output: options.output,
    trustedRoot: TOOLING_ROOT,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        output: options.output,
        tasks: result.tasks.length,
        candidates: result.candidates.length,
        findings_validation: result.findingsValidation,
      },
      null,
      2,
    )}\n`,
  );
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    resolve(entrypoint) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule())
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Security review failed.';
    console.error(message);
    process.exitCode = 1;
  });
