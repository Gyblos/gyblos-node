// Owns bounded Git object reads; it never reads the working tree or invokes target scripts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MAX_DIFF_BYTES, MAX_PROJECTION_FILE_BYTES } from './constants';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const GIT_OUTPUT_LIMIT = 12_582_912;

async function gitText(
  root: string,
  args: string[],
  maxBuffer = GIT_OUTPUT_LIMIT,
): Promise<string> {
  const result = await execFileAsync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return result.stdout;
}
export async function resolveRef(root: string, ref: string): Promise<string> {
  const sha = (
    await gitText(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      ref + '^{commit}',
    ])
  ).trim();
  if (!SHA.test(sha)) throw new Error('Expected an immutable Git commit SHA.');
  return sha;
}
export async function repositoryRef(root: string): Promise<string> {
  return resolveRef(root, 'HEAD');
}
function requireSha(ref: string): void {
  if (!SHA.test(ref))
    throw new Error('Git source refs must be full commit SHAs.');
}
export async function trackedFiles(
  root: string,
  ref: string,
): Promise<string[]> {
  requireSha(ref);
  return (await gitText(root, ['ls-tree', '-rz', '--name-only', ref]))
    .split('\0')
    .filter(Boolean);
}
export async function changedFiles(
  root: string,
  base: string,
  head: string,
): Promise<string[]> {
  requireSha(base);
  requireSha(head);
  return (
    await gitText(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      base + '..' + head,
      '--',
    ])
  )
    .split('\0')
    .filter(Boolean);
}
// A tracked path that is not text source (a symlink, submodule or binary blob): excluded, not omitted.
export class UnsupportedSourceError extends Error {}
export async function trackedFile(
  root: string,
  ref: string,
  file: string,
): Promise<string | undefined> {
  requireSha(ref);
  const entry = await gitText(root, [
    'ls-tree',
    '-lz',
    ref,
    '--',
    ':(literal)' + file,
  ]);
  if (!entry) return undefined;
  const header = entry.slice(0, entry.indexOf('\t')).trim().split(/\s+/);
  const mode = header[0];
  const size = Number(header[3]);
  if (!['100644', '100755'].includes(mode ?? '') || header[1] !== 'blob')
    throw new UnsupportedSourceError('Only regular Git blobs may be reviewed.');
  if (!Number.isSafeInteger(size) || size > MAX_PROJECTION_FILE_BYTES)
    throw new Error('Source file exceeds the byte limit.');
  const text = await gitText(
    root,
    ['cat-file', 'blob', header[2] ?? ''],
    MAX_PROJECTION_FILE_BYTES,
  );
  if (text.includes('\0'))
    throw new UnsupportedSourceError(
      'Binary source is outside this text review.',
    );
  return text;
}
export async function sourceDiff(
  root: string,
  base: string,
  head: string,
  paths: string[],
): Promise<string> {
  requireSha(base);
  requireSha(head);
  if (paths.length === 0) return '';
  return gitText(
    root,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--unified=5',
      base + '..' + head,
      '--',
      ...paths.map((path) => ':(literal)' + path),
    ],
    MAX_DIFF_BYTES,
  );
}
