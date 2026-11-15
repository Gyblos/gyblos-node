// Pilot selection does not turn the default session capacity into public reusable admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SELLER_SESSION_BUYER_ENV,
  SELLER_SESSION_BUYERS_ENV,
} from '@gyblos/config/batch-session';
import { sellerSessionBuyerIds } from '@gyblos/node/seller-session-chain';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

const A = '12'.repeat(32);
const B = '34'.repeat(32);

void test('no selected pilot buyers remains disabled independently of max_sessions default', () => {
  assert.deepEqual(sellerSessionBuyerIds({}), []);
});
void test('the plural pilot value accepts several peers and the singular value remains a compatibility alias', () => {
  assert.deepEqual(
    sellerSessionBuyerIds({ [SELLER_SESSION_BUYERS_ENV]: `${A},${B}` }),
    [A, B],
  );
  assert.deepEqual(sellerSessionBuyerIds({ [SELLER_SESSION_BUYER_ENV]: A }), [
    A,
  ]);
});
void test('ambiguous, duplicated, malformed or excessive pilot selection is refused without reflecting input', () => {
  for (const env of [
    { [SELLER_SESSION_BUYERS_ENV]: `${A},${A}` },
    { [SELLER_SESSION_BUYERS_ENV]: 'AF'.repeat(32) },
    { [SELLER_SESSION_BUYERS_ENV]: '' },
    { [SELLER_SESSION_BUYERS_ENV]: A, [SELLER_SESSION_BUYER_ENV]: B },
    {
      [SELLER_SESSION_BUYERS_ENV]: Array.from({ length: 17 }, (_, i) =>
        i.toString(16).padStart(64, '0'),
      ).join(','),
    },
  ])
    assert.throws(
      () => sellerSessionBuyerIds(env),
      (error: unknown) =>
        error instanceof PaymentSessionError &&
        error.code === SESSION_CODES.INVALID &&
        !error.message.includes(A),
    );
});
