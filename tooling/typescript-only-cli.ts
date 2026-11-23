import { execFileSync } from 'node:child_process';

import { javascriptFiles } from './typescript-only';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const found = javascriptFiles(tracked);
for (const path of found)
  console.error(`${path}: JavaScript-family code must be TypeScript.`);
if (found.length > 0) process.exitCode = 1;
else console.log('TypeScript only: no JavaScript-family files tracked.');
