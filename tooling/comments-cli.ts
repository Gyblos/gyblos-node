import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseForESLint } from '@typescript-eslint/parser';

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
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.dockerfile',
  '.headers',
  '.html',
  '.js',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.ps1',
  '.py',
  '.sh',
  '.shell',
  '.redirects',
  '.sql',
  '.svg',
  '.ts',
  '.tsx',
  '.toml',
  '.yaml',
  '.yml',
]);
const TYPESCRIPT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

type CommentRange = { start: number; end: number };
type CommentOptions = {
  blockMarkers: { start: string; end: string }[];
  hashMarker?: string;
  adjacentHash?: boolean;
  powershell?: boolean;
  lineMarkers: string[];
};
type SourceCommentStats = { comments: number; lines: number };
type BudgetRecord = Record<string, number>;

function sourceExtension(path: string): string {
  const basename = path.split(/[\\/]/).at(-1) ?? '';
  if (['Dockerfile', 'Containerfile'].includes(basename)) return '.dockerfile';
  if (basename === '_headers') return '.headers';
  if (basename === '_redirects') return '.redirects';
  if (basename === 'gyblos') return '.shell';
  if (basename === '.env.example') return '.shell';
  return extname(path).toLowerCase();
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(sourceExtension(path));
}

function sourceFiles(): string[] {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return paths
    .split('\0')
    .filter(
      (path) =>
        path &&
        (!path.includes('/') || SOURCE_ROOTS.has(path.split('/')[0] ?? '')) &&
        !path.includes('/evidence/') &&
        isSourceFile(path),
    )
    .sort()
    .map((path) => resolve(ROOT, path));
}

function typescriptCommentRanges(text: string, path: string): CommentRange[] {
  const { ast } = parseForESLint(text, {
    filePath: path,
    comment: true,
    range: true,
    jsx: true,
  });
  return (ast.comments ?? [])
    .filter(
      (comment) => text.slice(comment.range[0], comment.range[0] + 2) !== '#!',
    )
    .map((comment) => ({ start: comment.range[0], end: comment.range[1] }));
}

function delimitedCommentRanges(
  text: string,
  options: CommentOptions,
): CommentRange[] {
  const ranges: CommentRange[] = [];
  let index = 0;
  let quote = '';
  let quoteLength = 1;
  while (index < text.length) {
    const character = text[index];
    if (quote.length > 0) {
      if (
        options.powershell
          ? quote === '"' && character === '`'
          : character === '\\'
      ) {
        index += 2;
        continue;
      }
      if (
        character === quote &&
        (quoteLength === 1 ||
          text.slice(index, index + quoteLength) === quote.repeat(quoteLength))
      ) {
        if (quoteLength === 1 && quote === "'" && text[index + 1] === "'") {
          index += 2;
          continue;
        }
        quote = '';
        index += quoteLength;
        continue;
      }
      index += 1;
      continue;
    }
    if (
      (character === "'" && !/[a-z0-9]/i.test(text[index - 1] ?? '')) ||
      character === '"' ||
      (!options.powershell && character === '`')
    ) {
      quote = character;
      quoteLength =
        character !== '`' &&
        text.slice(index, index + 3) === character.repeat(3)
          ? 3
          : 1;
      index += quoteLength;
      continue;
    }
    const block = options.blockMarkers.find((marker) =>
      text.startsWith(marker.start, index),
    );
    if (block) {
      const close = text.indexOf(block.end, index + block.start.length);
      const end = close < 0 ? text.length : close + block.end.length;
      ranges.push({ start: index, end });
      index = end;
      continue;
    }
    const line = options.lineMarkers.find((marker) =>
      text.startsWith(marker, index),
    );
    if (line) {
      const end = text.indexOf('\n', index);
      ranges.push({ start: index, end: end < 0 ? text.length : end });
      index = end < 0 ? text.length : end;
      continue;
    }
    if (
      options.hashMarker &&
      character === options.hashMarker &&
      (options.adjacentHash || index === 0 || /\s/.test(text[index - 1] ?? ''))
    ) {
      const end = text.indexOf('\n', index);
      ranges.push({ start: index, end: end < 0 ? text.length : end });
      index = end < 0 ? text.length : end;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function commentRanges(text: string, path: string): CommentRange[] {
  const extension = sourceExtension(path);
  if (TYPESCRIPT_EXTENSIONS.has(extension))
    return typescriptCommentRanges(text, path);
  if (extension === '.css')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: [],
    });
  if (extension === '.sql')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: ['--'],
    });
  if (extension === '.html' || extension === '.svg')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '<!--', end: '-->' }],
      lineMarkers: [],
    });
  if (extension === '.jsonc')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: ['//'],
    });
  if (extension === '.ps1')
    return delimitedCommentRanges(text, {
      powershell: true,
      blockMarkers: [{ start: '<#', end: '#>' }],
      hashMarker: '#',
      lineMarkers: [],
    });
  return delimitedCommentRanges(text, {
    blockMarkers: [],
    adjacentHash: extension === '.py' || extension === '.toml',
    hashMarker: '#',
    lineMarkers: [],
  }).filter((range) => range.start !== 0 || !text.startsWith('#!'));
}

function physicalLines(text: string, range: CommentRange): number {
  return text.slice(range.start, range.end).split(/\r\n|\r|\n/).length;
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
      lines: ranges.reduce(
        (total, range) => total + physicalLines(text, range),
        0,
      ),
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

  const filename = 'tooling/source-comment-budget.json';
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const base =
    process.env.COMMENT_BASE_SHA ||
    git(['merge-base', 'HEAD', 'origin/develop']).trim();
  if (git(['ls-tree', base, '--', filename]).trim()) {
    const previous: unknown = JSON.parse(git(['show', base + ':' + filename]));
    if (!isBudgetRecord(previous))
      throw new Error('Invalid base comment budget.');
    for (const [path, count] of Object.entries(budgets))
      if (count > (previous[path] ?? 0))
        problems.push(path + ': comment budget increased');
  }
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

void run().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Comment budget check failed.',
  );
  process.exitCode = 1;
});
