// Payment labels distinguish the selected method from wallet balances.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canSelectPreviewModel,
  PAYMENT_METHOD,
  paymentMethodLabel,
  paypalActivityLabel,
  paypalAmountsAvailable,
  paypalFinishDialog,
  paypalHasUnfinishedSession,
} from '@gyblos/desktop/paypal-model';

void test('the selected payment method is identified without inventing a balance', () => {
  assert.equal(paymentMethodLabel(PAYMENT_METHOD.USDC), 'USDC preview');
  assert.equal(paymentMethodLabel(PAYMENT_METHOD.PAYPAL), 'PayPal Sandbox');
});

void test('unknown and blocked sessions do not present default amounts as recorded usage', () => {
  assert.equal(paypalAmountsAvailable(null), false);
  assert.equal(paypalAmountsAvailable({ phase: 'blocked' }), false);
  assert.equal(paypalAmountsAvailable({ phase: 'ready' }), false);
  assert.equal(paypalAmountsAvailable({ phase: 'active' }), true);
  assert.equal(paypalAmountsAvailable({ phase: 'review' }), true);
});

void test('an unfinished PayPal session remains identifiable after switching methods', () => {
  assert.equal(paypalHasUnfinishedSession(null), false);
  assert.equal(paypalHasUnfinishedSession({ phase: 'active' }), true);
  assert.equal(paypalHasUnfinishedSession({ phase: 'review' }), true);
  assert.equal(paypalHasUnfinishedSession({ phase: 'completed' }), false);
  assert.equal(paypalHasUnfinishedSession({ phase: 'voided' }), false);
});

void test('activity labels distinguish recorded usage from confirmed settlement', () => {
  assert.equal(paypalActivityLabel(null), 'Status unavailable');
  assert.equal(
    paypalActivityLabel({ phase: 'active', expired: false }),
    'Session active',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'active', expired: true }),
    'Session expired',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'completed', expired: false }),
    'Payment captured',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'review', expired: false }),
    'Needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'capturing', expired: false }),
    'Closing or needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'created', expired: false }),
    'Approval not confirmed',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'authorizing', expired: false }),
    'Preparing or needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'cancelled', expired: false }),
    'Checkout abandoned locally',
  );
});

void test('settlement confirmation names the test amount and distinguishes an unused authorization', () => {
  const capture = paypalFinishDialog({ spentCents: 30, limitCents: 100 });
  assert.match(capture.detail ?? '', /USD 0\.30/);
  assert.match(capture.detail ?? '', /test funds/i);
  assert.equal(capture.defaultId, 0);
  assert.equal(capture.cancelId, 0);
  const unused = paypalFinishDialog({ spentCents: 0, limitCents: 100 });
  assert.match(unused.detail ?? '', /void/i);
  assert.doesNotMatch(unused.detail ?? '', /capture/i);
});

void test('sandbox does not present preview catalog models as selectable', () => {
  assert.equal(canSelectPreviewModel(PAYMENT_METHOD.USDC), true);
  assert.equal(canSelectPreviewModel(PAYMENT_METHOD.PAYPAL), false);
});
