import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_DIRECTORIES = [
  'apps',
  'packages',
  'scripts',
  'tooling',
  'docker/p2p',
];
const ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  '.dockerignore',
];
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.local', '.git']);

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function sourceFingerprint() {
  const files = [...ROOT_FILES];
  for (const directory of SOURCE_DIRECTORIES)
    files.push(...(await sourceFiles(directory)));
  const hash = createHash('sha256');
  for (const file of files.sort())
    hash
      .update(file)
      .update('\0')
      .update(await readFile(file))
      .update('\0');
  return {
    algorithm: 'sha256(sorted source path NUL bytes NUL)',
    digest: hash.digest('hex'),
  };
}
