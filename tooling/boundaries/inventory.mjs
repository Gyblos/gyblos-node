// Owns source enumeration for checkouts and tracked-only source archives.
// Private/generated trees and symlinks must never be traversed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PRIVATE_PATH, SOURCE_ROOTS } from './config.mjs';

const EXCLUDED = new RegExp(`(?:${PRIVATE_PATH})|(^|/)node_modules(?:/|$)`);
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?tsx?)$/;

async function walk(root, directory) {
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const name = `${directory}/${entry.name}`;
    if (EXCLUDED.test(name) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await walk(root, name)));
    else if (entry.isFile() && SOURCE_FILE.test(name)) files.push(name);
  }
  return files;
}

export async function sourceFiles(root) {
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
  return [
    ...new Set(
      files.filter((file) => SOURCE_FILE.test(file) && !EXCLUDED.test(file)),
    ),
  ].sort();
}
