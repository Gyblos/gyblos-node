import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { JAVASCRIPT_EXCEPTIONS, javascriptFiles } from './typescript-only';

void test('JavaScript-family files are reported and TypeScript and data files are not', () => {
  assert.deepEqual(
    javascriptFiles(
      [
        'scripts/a.mjs',
        'apps/x/b.cjs',
        'eslint.config.js',
        'tooling/c.ts',
        'apps/x/d.tsx',
        'apps/x/e.d.ts',
        'apps/x/postcss.config.json',
        'docs/js.md',
        'apps/x/name.js.snap',
      ],
      [],
    ),
    ['apps/x/b.cjs', 'eslint.config.js', 'scripts/a.mjs'],
  );
});

void test('only an exact recorded path is exempt', () => {
  assert.deepEqual(
    javascriptFiles(
      ['eslint.config.js', 'apps/x/eslint.config.js'],
      ['eslint.config.js'],
    ),
    ['apps/x/eslint.config.js'],
  );
});

void test('the repository tracks no JavaScript-family file outside the recorded exceptions', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(javascriptFiles(tracked), []);
  for (const exception of JAVASCRIPT_EXCEPTIONS)
    assert.ok(tracked.includes(exception), exception);
});
