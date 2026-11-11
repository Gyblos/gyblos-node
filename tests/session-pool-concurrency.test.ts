// Two seller channels run independently; durable live ownership never becomes a recovery operation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { multisellerLoopback } from './support/multiseller-session';

function completed() {
  return { text: 'ok!', finishReason: ENGINE_DONE_REASONS.STOP, usage: { inputTokens: 2, outputTokens: 3, totalDurationNs: 0, loadDurationNs: 0, inputDurationNs: 0, outputDurationNs: 0 } };
}
void test('B completes while A is generating and A is reused afterward without another deposit', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const started = batchDeferred<void>();
  const finish = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => { started.resolve(); await finish.promise; return completed(); });
  t.after(async () => { finish.resolve(); await buyer.close(); await fixture.close(); });
  const a = buyer.execute(await fixture.offers[0]!.quote(1), fixture.offers[0]!.input, AbortSignal.timeout(3000));
  await started.promise;
  try {
    const b = await buyer.execute(await fixture.offers[1]!.quote(2), fixture.offers[1]!.input, AbortSignal.timeout(3000));
    assert.equal(b.value.text, 'ok!');
    await assert.rejects(buyer.execute(await fixture.offers[0]!.quote(3), fixture.offers[0]!.input, AbortSignal.timeout(3000)), { code: SESSION_CODES.BUSY });
    assert.deepEqual(fixture.a.calls, ['deposit']);
    assert.deepEqual(fixture.b.calls, ['deposit']);
  } finally { finish.resolve(); await a; }
  await buyer.execute(await fixture.offers[0]!.quote(4), fixture.offers[0]!.input, AbortSignal.timeout(3000));
  assert.equal(fixture.offers[0]!.generations(), 2);
  assert.deepEqual(fixture.a.calls, ['deposit']);
});
void test('preflight reports no unresolved obligation for a live owned request and settlement remains exclusive', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const started = batchDeferred<void>();
  const finish = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => { started.resolve(); await finish.promise; return completed(); });
  t.after(async () => { finish.resolve(); await buyer.close(); await fixture.close(); });
  const a = buyer.execute(await fixture.offers[0]!.quote(1), fixture.offers[0]!.input, AbortSignal.timeout(3000));
  await started.promise;
  try {
    assert.equal(await buyer.unresolved(), false);
    await assert.rejects(buyer.settle(AbortSignal.timeout(1000)), { code: SESSION_CODES.BUSY });
  } finally { finish.resolve(); await a; }
});
