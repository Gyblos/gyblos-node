import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');
const SCAN_ROOTS = ['app', 'components', 'boardui/components'];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

void test('no class string pairs outline-none with focus-visible outline utilities', () => {
  const literal = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gs;
  const offenders: string[] = [];
  for (const dir of SCAN_ROOTS)
    for (const path of sourceFiles(dir)) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      for (const match of source.matchAll(literal)) {
        const body = match[0].slice(1, -1);
        if (
          /(^|\s)outline-none(\s|$)/.test(body) &&
          /focus-visible:outline-(?!none\b)/.test(body)
        )
          offenders.push(`${path}: ${body.trim().slice(0, 120)}`);
      }
    }
  assert.deepEqual(offenders, []);
});

void test('the global anchor focus rule lives in the base cascade layer', () => {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const opening = css.indexOf('@layer base');
  assert.notEqual(opening, -1, 'globals.css has no @layer base block');
  const brace = css.indexOf('{', opening);
  let depth = 0;
  let end = brace;
  for (; end < css.length; end += 1) {
    if (css[end] === '{') depth += 1;
    if (css[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = css.slice(brace, end);
  const outside = css.slice(0, opening) + css.slice(end);
  assert.ok(
    /a:focus-visible/.test(block),
    'a:focus-visible is not inside @layer base',
  );
  assert.ok(
    !/a:focus-visible/.test(outside),
    'a:focus-visible also exists outside @layer base',
  );
});
