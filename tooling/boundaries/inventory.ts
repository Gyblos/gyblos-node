// Owns source enumeration for checkouts and tracked-only source archives.
// Private/generated trees and symlinks must never be traversed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PRIVATE_PATH, SOURCE_ROOTS } from './config';

const EXCLUDED = new RegExp(`(?:${PRIVATE_PATH})|(^|/)node_modules(?:/|$)`);
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?tsx?)$/;

export async function isSafeSource(
  root: string,
  name: string,
): Promise<boolean> {
  if (EXCLUDED.test(name)) return false;
  let current = root;
  for (const part of name.split('/')) {
    if (part === '..' || part === '' || part === '.') return false;
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) return false;
  }
  return true;
}

async function walk(root: string, directory: string): Promise<string[]> {
  let entries;
  try {
    if (!(await isSafeSource(root, directory))) return [];
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const name = `${directory}/${entry.name}`;
    if (EXCLUDED.test(name) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await walk(root, name)));
    else if (entry.isFile() && SOURCE_FILE.test(name)) files.push(name);
  }
  return files;
}

export async function sourceFiles(root: string): Promise<string[]> {
  const files = existsSync(join(root, '.git'))
    ? execFileSync(
        'git',
        [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
          '--',
          ...SOURCE_ROOTS,
        ],
        {
          cwd: root,
          encoding: 'utf8',
        },
      ).split('\0')
    : (
        await Promise.all(
          SOURCE_ROOTS.map((directory) => walk(root, directory)),
        )
      ).flat();
  const sources = [
    ...new Set(
      files.filter((file) => SOURCE_FILE.test(file) && !EXCLUDED.test(file)),
    ),
  ].sort();
  const safe = await Promise.all(
    sources.map((file) => isSafeSource(root, file)),
  );
  return sources.filter((_file, index) => safe[index]);
}
