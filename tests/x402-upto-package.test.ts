// Pins the standalone x402 upto package: no workspace dependencies, permissive license and static error codes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { UPTO_ERROR_CODES, UptoError, uptoError } from 'x402-upto-metered';

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

void test('error codes are static, unique and namespaced', () => {
  const codes = Object.values(UPTO_ERROR_CODES);
  assert.ok(codes.length > 0);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^UPTO_[A-Z_]+$/);
  const error = new UptoError(UPTO_ERROR_CODES.ALREADY_SETTLED);
  assert.equal(error.code, UPTO_ERROR_CODES.ALREADY_SETTLED);
  assert.equal(error.message, UPTO_ERROR_CODES.ALREADY_SETTLED);
  assert.equal(error.name, 'UptoError');
});

void test('foreign failures become an internal code without leaking their text', () => {
  const known = new UptoError(UPTO_ERROR_CODES.CHANNEL_REUSED);
  assert.equal(uptoError(known), known);
  for (const foreign of [
    new Error('https://rpc.example/?api-key=FAKE0SECRET'),
    'FAKE0SECRET',
    null,
    { code: UPTO_ERROR_CODES.ALREADY_SETTLED },
  ]) {
    const mapped = uptoError(foreign);
    assert.equal(mapped.code, UPTO_ERROR_CODES.INTERNAL);
    assert.doesNotMatch(mapped.message, /FAKE0SECRET|https?:/);
  }
});
