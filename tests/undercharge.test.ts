// Owns offline undercharge.test regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { assessCharge } from '@gyblos/core/metering';

void test('undercharge is explicit only beyond tolerance for delivered successful inference', () => {
  const counts = { input: 20, output: 60 };
  const result = assessCharge(133n, counts, true, false);
  assert.equal(result.anomaly, 'undercharge');
  assert.equal(result.expectedAtomic, '140');
  assert.equal(result.differenceAtomic, '-7');
  assert.equal(result.allowanceAtomic, '6');
  assert.equal(result.relativeDifference, -0.05);
  for (const amount of [134n, 135n, 140n, 146n])
    assert.equal(assessCharge(amount, counts, true, false).anomaly, 'none');
  assert.equal(assessCharge(147n, counts, true, false).anomaly, 'overcharge');
  assert.equal(assessCharge(0n, counts, true, false).anomaly, 'undercharge');
  assert.equal(
    assessCharge(0n, { input: 0, output: 0 }, true, false).anomaly,
    'none',
  );
});

void test('undercharge does not hide failed or incomplete delivery', () => {
  const counts = { input: 20, output: 60 };
  assert.equal(assessCharge(0n, counts, false, true).anomaly, 'failed');
  assert.equal(assessCharge(133n, counts, false, false).anomaly, 'incomplete');
  assert.equal(assessCharge(1n, counts, false, true).anomaly, 'overcharge');
});

void test('relative token tolerance bounds undercharge at larger counts', () => {
  const counts = { input: 1000, output: 1000 };
  assert.equal(assessCharge(2940n, counts, true, false).anomaly, 'none');
  assert.equal(assessCharge(2939n, counts, true, false).anomaly, 'undercharge');
  assert.equal(assessCharge(3060n, counts, true, false).anomaly, 'none');
  assert.equal(assessCharge(3061n, counts, true, false).anomaly, 'overcharge');
});
