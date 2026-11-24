import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  JAVASCRIPT_EXCEPTIONS,
  javascriptFiles,
  trackedPaths,
} from './typescript-only';

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
  const tracked = trackedPaths(
    execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }),
  );
  assert.deepEqual(javascriptFiles(tracked), []);
  for (const exception of JAVASCRIPT_EXCEPTIONS)
    assert.ok(tracked.includes(exception), exception);
});

void test('upper-case extensions and JSX are reported too', () => {
  assert.deepEqual(
    javascriptFiles(['a.MJS', 'b.jsx', 'c.Js', 'd.tsx', 'e.json'], []),
    ['a.MJS', 'b.jsx', 'c.Js'],
  );
});

void test('tracked paths are read without quoting, so no name can hide a file', () => {
  assert.deepEqual(trackedPaths('a.ts\0caf\u00e9.mjs\0with space.js\0'), [
    'a.ts',
    'caf\u00e9.mjs',
    'with space.js',
  ]);
});
