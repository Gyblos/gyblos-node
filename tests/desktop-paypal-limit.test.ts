// Editable limits accept only the existing sandbox terms; typing never broadens payment policy.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionLimitCents } from '@gyblos/desktop/paypal-limit';

void test('the session limit field resolves the approved one, five and ten dollar amounts', () => {
  assert.equal(sessionLimitCents('1'), 100);
  assert.equal(sessionLimitCents('5.00'), 500);
  assert.equal(sessionLimitCents('10'), 1000);
});
void test('the field refuses empty, malformed and unsupported amounts before checkout', () => {
  for (const value of [
    '',
    '0',
    '2',
    '100',
    '-1',
    '1e0',
    '5.01',
    'Infinity',
    'NaN',
  ])
    assert.equal(sessionLimitCents(value), null);
});
