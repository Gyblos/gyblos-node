// Pins the standalone x402 upto package manifest: no workspace dependencies and a permissive license.
// Error behavior is tested inside the package (packages/x402-upto-metered/test).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { UPTO_ERROR_CODES } from 'x402-upto-metered';

const PACKAGE = new URL('../packages/x402-upto-metered/', import.meta.url);
const ALLOWED_DEPENDENCY = /^(?:@x402\/|@solana\/|@solana-program\/)/;

async function manifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL('package.json', PACKAGE), 'utf8'));
}

void test('the package declares Apache-2.0 and ships its license and notice', async () => {
  const pkg = await manifest();
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.private, true);
  const license = await readFile(new URL('LICENSE', PACKAGE), 'utf8');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  const notice = await readFile(new URL('NOTICE', PACKAGE), 'utf8');
  assert.match(notice, /x402-upto-metered/);
  await readFile(new URL('README.md', PACKAGE), 'utf8');
});

void test('the package depends on no workspace package', async () => {
  const pkg = await manifest();
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const entries = Object.entries(
      (pkg[field] ?? {}) as Record<string, string>,
    );
    for (const [name, version] of entries) {
      assert.doesNotMatch(name, /^@gyblos\//, `${field}: ${name}`);
      assert.doesNotMatch(version, /^workspace:/, `${field}: ${name}`);
      if (field !== 'devDependencies')
        assert.match(name, ALLOWED_DEPENDENCY, `${field}: ${name}`);
    }
  }
  assert.deepEqual(Object.keys(pkg.exports as object), ['.']);
});

void test('the workspace resolves the package by its own name', () => {
  assert.equal(UPTO_ERROR_CODES.INTERNAL, 'UPTO_INTERNAL');
});
