import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { javascriptFiles, trackedPaths } from './typescript-only';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = trackedPaths(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }),
);
const found = javascriptFiles(tracked);
for (const path of found)
  console.error(`${path}: JavaScript-family code must be TypeScript.`);
if (found.length > 0) process.exitCode = 1;
else console.log('TypeScript only: no JavaScript-family files tracked.');
