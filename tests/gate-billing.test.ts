import assert from 'node:assert/strict';
import test from 'node:test';

import { createGateBilling } from '../lab/harness/src/cli/inference/billing.js';
import { assessCharge, charge } from '../packages/application/src/metering.js';

test('gate underbilling changes only selected output counts without mutating usage', () => {
  const billing = createGateBilling('sponsor', 'over-request', 'under-request');
  const usage = Object.freeze({ input: 24, output: 110 });
  assert.equal(billing.feePayer, 'sponsor');
  assert.deepEqual(billing.billingOverride('under-request', usage), {
    input: 24,
    output: 66,
  });
  assert.deepEqual(billing.billingOverride('ordinary-request', usage), usage);
  assert.deepEqual(
    billing.billingOverride('under-request-other', usage),
    usage,
  );
  assert.deepEqual(usage, { input: 24, output: 110 });
});

test('gate billing retains upward adversarial rounding and floors the discounted count', () => {
  const billing = createGateBilling('sponsor', 'over-request', 'under-request');
  assert.deepEqual(
    billing.billingOverride('over-request', { input: 10, output: 3 }),
    { input: 10, output: 5 },
  );
  assert.deepEqual(
    billing.billingOverride('under-request', { input: 10, output: 3 }),
    { input: 10, output: 1 },
  );
  assert.deepEqual(
    billing.billingOverride('under-request', { input: 10, output: 0 }),
    { input: 10, output: 0 },
  );
});

test('gate discounted billing yields a positive undercharge outside buyer tolerance', () => {
  const billing = createGateBilling('sponsor', 'over-request', 'under-request');
  const actual = charge(
    billing.billingOverride('under-request', { input: 24, output: 110 }),
  );
  const observed = assessCharge(
    actual,
    { input: 24, output: 109 },
    true,
    false,
  );
  assert.ok(actual > 0n);
  assert.equal(actual, 156n);
  assert.equal(observed.anomaly, 'undercharge');
  assert.equal(observed.expectedAtomic, '242');
  assert.equal(observed.allowanceAtomic, '8');
  assert.equal(observed.differenceAtomic, '-86');
});
