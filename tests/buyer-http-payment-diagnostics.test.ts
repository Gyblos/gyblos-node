// A paid chat that fails at the buyer's HTTP boundary records the payment cause from closed catalogs:
// the payment SDK's failure name (even behind a generic session code) or the typed payment code, never
// the error text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ERROR_DIAGNOSTICS, PAID_BUYER_CODES } from '@gyblos/buyer/constants';
import { httpDiagnostics } from '@gyblos/buyer/http-diagnostics';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { UnsentChannelRequestError } from '@gyblos/node/buyer-session';
import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
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

void test('buyer HTTP failures keep routing and unsent channel codes', () => {
  for (const code of Object.values(BUYER_ROUTING_CODES))
    assert.equal(failed(new BuyerRoutingError(code)).code, code);
  assert.equal(
    failed(new UnsentSellerBusyError('a'.repeat(64))).code,
    BUYER_ROUTING_CODES.BUSY,
  );
  assert.equal(
    failed(
      new UnsentChannelRequestError(
        'a'.repeat(64),
        new BatchChannelError(PAID_EXECUTION_CODES.TIMEOUT),
      ),
    ).code,
    PAID_EXECUTION_CODES.TIMEOUT,
  );
  assert.equal(
    failed(
      new UnsentChannelRequestError(
        'a'.repeat(64),
        new Error('PRIVATE_SENTINEL'),
      ),
    ).code,
    SESSION_CODES.UNAVAILABLE,
  );
});
