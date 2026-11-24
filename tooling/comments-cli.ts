import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addedComments, physicalLineCount } from './comment-lines';
import { commentRanges, commentTexts, isSourceFile } from './comment-scanner';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUDGET_PATH = resolve(ROOT, 'tooling/source-comment-budget.json');
const SOURCE_ROOTS = new Set([
  '.github',
  'apps',
  'docker',
  'examples',
  'packages',
  'lab',
  'tests',
  'tooling',
  'scripts',
  'patches',
]);
const GIT_OUTPUT_BYTES = 67_108_864;
const RENAME_FIELDS = 3;
const CHANGE_FIELDS = 2;

type SourceCommentStats = { comments: number; lines: number };
type BudgetRecord = Record<string, number>;
type Git = (args: string[]) => string;

function isScannedPath(path: string): boolean {
  return (
    path.length > 0 &&
    (!path.includes('/') || SOURCE_ROOTS.has(path.split('/')[0] ?? '')) &&
    !path.includes('/evidence/') &&
    isSourceFile(path)
  );
}

export function renamedBaseComments(
  text: string,
  previous: string,
  path: string,
): string[] {
  return isScannedPath(previous) && isScannedPath(path)
    ? commentTexts(text, previous)
    : [];
}

function sourceFiles(): string[] {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_OUTPUT_BYTES },
  );
  return paths
    .split('\0')
    .filter(isScannedPath)
    .sort()
    .map((path) => resolve(ROOT, path));
}

export function commentBase(
  env: Record<string, string | undefined>,
  git: Git,
): string {
  if (env.COMMENT_BASE_SHA) return env.COMMENT_BASE_SHA;
  for (const ref of ['upstream/develop', 'origin/develop']) {
    try {
      return git(['merge-base', 'HEAD', ref]).trim();
    } catch {
      continue;
    }
  }
  throw new Error(
    'No develop branch to compare comments against: fetch origin/develop or upstream/develop, or set COMMENT_BASE_SHA.',
  );
}

export function changedSources(git: Git, base: string): [string, string?][] {
  const fields = git(['diff', '--name-status', '-z', '-M', base, '--']).split(
    '\0',
  );
  const changed: [string, string?][] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index] ?? '';
    if (/^[RC]/.test(status)) {
      changed.push([fields[index + 2] ?? '', fields[index + 1]]);
      index += RENAME_FIELDS;
      continue;
    }
    if (status !== 'D')
      changed.push([
        fields[index + 1] ?? '',
        status === 'A' ? undefined : fields[index + 1],
      ]);
    index += CHANGE_FIELDS;
  }
  for (const path of git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).split('\0'))
    if (path) changed.push([path, undefined]);
  return changed;
}

async function newCommentProblems(
  git: Git,
  base: string,
  stats: Map<string, SourceCommentStats>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [path, previous] of changedSources(git, base)) {
    if (!stats.has(path)) continue;
    const before = previous
      ? renamedBaseComments(
          git(['show', base + ':' + previous]),
          previous,
          path,
        )
      : [];
    const after = await readFile(resolve(ROOT, path), 'utf8');
    for (const comment of addedComments(before, commentTexts(after, path)))
      problems.push(`${path}: new comment ${JSON.stringify(comment)}`);
  }
  return problems;
}

async function scanSourceFiles(): Promise<Map<string, SourceCommentStats>> {
  const files = sourceFiles();
  const stats = new Map<string, SourceCommentStats>();
  for (const path of files) {
    if (
      !lstatSync(path, { throwIfNoEntry: false })?.isFile() ||
      (await realpath(path)) !== path
    )
      continue;
    const text = await readFile(path, 'utf8');
    const ranges = commentRanges(text, path);
    stats.set(relative(ROOT, path).split('\\').join('/'), {
      comments: ranges.length,
      lines: physicalLineCount(text, ranges),
    });
  }
  return stats;
}

function isBudgetRecord(value: unknown): value is BudgetRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.entries(value).every(
    ([path, budget]) =>
      path.length > 0 &&
      typeof budget === 'number' &&
      Number.isSafeInteger(budget) &&
      budget >= 0,
  );
}

async function readBudgets(): Promise<BudgetRecord> {
  if (
    (await realpath(BUDGET_PATH)) !== BUDGET_PATH ||
    !lstatSync(BUDGET_PATH).isFile()
  )
    throw new Error('Invalid budget file.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(BUDGET_PATH, 'utf8'));
  } catch {
    throw new Error('Invalid comment budget.');
  }
  if (!isBudgetRecord(parsed))
    throw new Error('Source comment budget is invalid.');
  return parsed;
}

function summarize(stats: Map<string, SourceCommentStats>) {
  let comments = 0;
  let lines = 0;
  let files = 0;
  for (const row of stats.values()) {
    comments += row.comments;
    lines += row.lines;
    if (row.comments > 0) files += 1;
  }
  return { comments, files, lines, scanned: stats.size };
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? 'check';
  const stats = await scanSourceFiles();
  const summary = summarize(stats);
  if (command === 'report') {
    if (process.argv.includes('--json')) {
      const budgets: BudgetRecord = {};
      for (const [path, row] of stats)
        if (row.comments > 0) budgets[path] = row.comments;
      console.log(JSON.stringify(budgets, null, 2));
      return;
    }
    console.log(
      `Source comments: ${summary.comments} comments in ${summary.files} files, spanning ${summary.lines} physical lines (${summary.scanned} files scanned).`,
    );
    return;
  }
  if (command !== 'check')
    throw new Error('Usage: comments-cli.ts check | report [--json]');

  const budgets = await readBudgets();
  const problems: string[] = [];

  const git: Git = (args) =>
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const base = commentBase(process.env, git);
  problems.push(...(await newCommentProblems(git, base, stats)));
  for (const [path, row] of stats) {
    const budget = budgets[path] ?? 0;
    if (row.comments > budget)
      problems.push(
        `${path}: ${row.comments} comments exceed budget ${budget}`,
      );
    if (row.comments < budget)
      problems.push(`${path}: reduce budget from ${budget} to ${row.comments}`);
  }
  for (const [path, budget] of Object.entries(budgets))
    if (!stats.has(path) && budget > 0)
      problems.push(`${path}: remove stale comment budget ${budget}`);

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Comment ratchet: ${summary.comments} comments in ${summary.files} files; ${summary.scanned} source files scanned.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void run().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Comment budget check failed.',
    );
    process.exitCode = 1;
  });
