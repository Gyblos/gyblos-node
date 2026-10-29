// Package-local error checks; they travel with the package if it leaves the monorepo.
import assert from 'node:assert/strict';
import test from 'node:test';

import { UPTO_ERROR_CODES, UptoError, uptoError } from '../src/index';

const SECRET = 'https://rpc.example/?api-key=FAKE0SECRET';

function assertClean(error: UptoError, code: string): void {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.name, 'UptoError');
  assert.doesNotMatch(String(error.stack), /FAKE0SECRET/);
}

void test('error codes are static, unique and namespaced', () => {
  const codes = Object.values(UPTO_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^UPTO_[A-Z_]+$/);
});

void test('package errors keep their code; anything else becomes internal', () => {
  const settled = new UptoError(UPTO_ERROR_CODES.ALREADY_SETTLED);
  assertClean(settled, UPTO_ERROR_CODES.ALREADY_SETTLED);
  assertClean(uptoError(settled), UPTO_ERROR_CODES.ALREADY_SETTLED);
  for (const foreign of [
    new Error(SECRET),
    SECRET,
    null,
    { code: UPTO_ERROR_CODES.ALREADY_SETTLED },
  ])
    assertClean(uptoError(foreign), UPTO_ERROR_CODES.INTERNAL);
});

void test('forged or rewritten package errors never carry foreign text out', () => {
  const rewritten = new UptoError(UPTO_ERROR_CODES.CHANNEL_REUSED);
  rewritten.message = SECRET;
  assertClean(uptoError(rewritten), UPTO_ERROR_CODES.CHANNEL_REUSED);
  const forged = Object.create(UptoError.prototype, {
    code: { value: SECRET },
    message: { value: SECRET },
  });
  assertClean(uptoError(forged), UPTO_ERROR_CODES.INTERNAL);
  assertClean(
    new UptoError(SECRET as typeof UPTO_ERROR_CODES.INTERNAL),
    UPTO_ERROR_CODES.INTERNAL,
  );
});
