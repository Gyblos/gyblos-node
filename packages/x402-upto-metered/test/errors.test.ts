// Package-local checks that travel with the package if it leaves the monorepo.
import assert from 'node:assert/strict';
import test from 'node:test';

import { UPTO_ERROR_CODES, UptoError, uptoError } from '../src/index';

void test('package errors keep their code and foreign ones become internal', () => {
  const settled = new UptoError(UPTO_ERROR_CODES.ALREADY_SETTLED);
  assert.equal(uptoError(settled), settled);
  const foreign = uptoError(new Error('https://rpc.example/?api-key=x'));
  assert.equal(foreign.code, UPTO_ERROR_CODES.INTERNAL);
  assert.equal(foreign.message, UPTO_ERROR_CODES.INTERNAL);
});
