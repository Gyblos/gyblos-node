// PayPal management follows the accepted chat-method transition and never initiates payment work.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { managePaypal, PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';

void test('blocked payment-method changes never open PayPal management', () => {
  let opened = false;
  assert.equal(
    managePaypal(
      () => false,
      () => {
        opened = true;
      },
    ),
    false,
  );
  assert.equal(opened, false);
});
void test('accepted PayPal selection opens management exactly once', () => {
  let opened = 0;
  const selected: string[] = [];
  assert.equal(
    managePaypal(
      (method) => {
        selected.push(method);
        return true;
      },
      () => {
        opened++;
      },
    ),
    true,
  );
  assert.deepEqual(selected, [PAYMENT_METHOD.PAYPAL]);
  assert.equal(opened, 1);
});
