// Exercises the x402 execution policy through public entries, with synthetic payment ports only.
// Request authentication belongs to the ALPN adapter; these inputs are already verified and metered.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createX402Policy,
  type X402AdmitContext,
} from '@gyblos/node/policy-x402';
import { PaidExecutionError } from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { paidSellerFixture } from './support/paid-seller';

async function fixture() {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  const policy = createX402Policy(seller.options);
  assert.ok(policy, 'the x402 policy must implement the execution port');
  const context: X402AdmitContext = {
    inputTokens: 4,
    signal: new AbortController().signal,
    now: seller.options.now,
    ready: () => {},
  };
  return { seller, request, policy, context };
}

void test('x402 admission returns the affordable ceiling and reserved claim deadline', async () => {
  const value = await fixture();
  const permit = await value.policy.admit(value.request, value.context);
  try {
    assert.equal(permit.outputTokens, 8);
    assert.equal(
      permit.deadline,
      value.request.quote.offer.expiresAt +
        120_000 -
        value.seller.options.settlement.waitMs,
    );
    assert.equal(value.seller.payment.calls.admit.length, 1);
    assert.equal(value.seller.engineCalls.length, 0);
  } finally {
    value.policy.release(permit);
  }
});

void test('x402 finish settles the same measured charge for complete and interrupted output', async () => {
  for (const completed of [true, false]) {
    const value = await fixture();
    const permit = await value.policy.admit(value.request, value.context);
    try {
      const result = await value.policy.finish(permit, {
        inputTokens: 4,
        outputTokens: 2,
        completed,
      });
      assert.deepEqual(result.charge, {
        inputTokens: 4,
        outputTokens: 2,
        chargedAtomic: '8',
      });
      assert.equal(result.payment.settlement?.chargedAtomic, '8');
      assert.equal(result.payment.settlement?.refundedAtomic, '12');
      assert.equal(value.seller.payment.calls.settle.length, 1);
    } finally {
      value.policy.release(permit);
    }
  }
});

void test('x402 finish with no delivered output refunds the entire deposit', async () => {
  const value = await fixture();
  const permit = await value.policy.admit(value.request, value.context);
  try {
    const result = await value.policy.finish(permit, {
      inputTokens: 4,
      outputTokens: 0,
      completed: false,
    });
    assert.equal(result.charge.chargedAtomic, '0');
    assert.equal(result.payment.settlement?.refundedAtomic, '20');
  } finally {
    value.policy.release(permit);
  }
});

void test('x402 finish survives prompt cancellation and release is idempotent', async () => {
  const value = await fixture();
  const controller = new AbortController();
  const permit = await value.policy.admit(value.request, {
    ...value.context,
    signal: controller.signal,
  });
  controller.abort();
  try {
    const result = await value.policy.finish(permit, {
      inputTokens: 4,
      outputTokens: 2,
      completed: false,
    });
    assert.equal(result.payment.settlement?.chargedAtomic, '8');
  } finally {
    value.policy.release(permit);
    value.policy.release(permit);
  }
  const next = await value.policy.admit(
    await value.seller.request(2),
    value.context,
  );
  value.policy.release(next);
  assert.equal(value.seller.payment.calls.admit.length, 2);
});

void test('x402 readiness refusal preserves replay use and frees its slot before deposit', async () => {
  const value = await fixture();
  await assert.rejects(
    value.policy.admit(value.request, {
      ...value.context,
      ready: () => {
        throw new PaidExecutionError(PAID_EXECUTION_CODES.BUSY);
      },
    }),
    { code: PAID_EXECUTION_CODES.BUSY },
  );
  await assert.rejects(value.policy.admit(value.request, value.context), {
    code: PAID_EXECUTION_CODES.REPLAY,
  });
  assert.equal(value.seller.payment.calls.admit.length, 0);
  const next = await value.policy.admit(
    await value.seller.request(2),
    value.context,
  );
  value.policy.release(next);
  assert.equal(value.seller.payment.calls.admit.length, 1);
});
