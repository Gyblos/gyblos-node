// A paid chat that fails at the buyer's HTTP boundary records the payment cause from closed catalogs:
// the payment SDK's failure name (even behind a generic session code) or the typed payment code, never
// the error text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ERROR_DIAGNOSTICS, PAID_BUYER_CODES } from '@gyblos/buyer/constants';
import { httpDiagnostics } from '@gyblos/buyer/http-diagnostics';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
import type { DiagnosticRecord } from '@gyblos/runtime/diagnostics';

function failed(error: unknown) {
  const records: DiagnosticRecord[] = [];
  const request = httpDiagnostics((record) => records.push(record))();
  request.executing();
  request.failure(error);
  assert.equal(records.length, 1);
  return records[0]!;
}

void test('buyer HTTP failures keep the payment cause from closed catalogs', () => {
  const sdk = new Error(
    'invalid_batch_settlement_svm_channel_state: rpc https://rpc.example/?key=PRIVATE_SENTINEL',
  );
  const behindSession = failed(
    new PaymentSessionError(SESSION_CODES.UNAVAILABLE, { cause: sdk }),
  );
  assert.equal(
    behindSession.code,
    'invalid_batch_settlement_svm_channel_state',
  );
  assert.doesNotMatch(
    JSON.stringify(behindSession),
    /PRIVATE_SENTINEL|rpc\.example/,
  );
  assert.equal(
    failed(new PaymentSessionError(SESSION_CODES.BINDING)).code,
    SESSION_CODES.BINDING,
  );
  assert.equal(
    failed(new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE)).code,
    PAYMENT_ERROR_CODES.UNAVAILABLE,
  );
  assert.equal(
    failed(new PaidBuyerError(PAID_BUYER_CODES.BUSY)).code,
    PAID_BUYER_CODES.BUSY,
  );
  // A code outside the catalogs and plain text stay unknown.
  assert.equal(
    failed(Object.assign(new Error('x'), { code: 'PRIVATE_SENTINEL' })).code,
    ERROR_DIAGNOSTICS.UNKNOWN,
  );
  assert.equal(
    failed(new Error('PRIVATE_SENTINEL')).code,
    ERROR_DIAGNOSTICS.UNKNOWN,
  );
});
