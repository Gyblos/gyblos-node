// Shared buyer/seller orchestration verifies usage before signing and never retries possible sends.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBatchSellerExecution } from '@gyblos/node/batch-session';
import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';
import { sessionRig } from './support/batch-session';

void test('shared session executes several requests and signs only after independent usage verification', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  for (const id of [1, 2, 3]) {
    const result = await f.buyer.execute(
      await f.offers.quote(id),
      f.offers.input,
    );
    assert.equal(result.text, 'ok!');
    assert.equal(f.session.snapshot().cumulativeAtomic, String(40 * id));
  }
  assert.equal(f.offers.generations(), 3);
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal((await f.session.close()).chargedAtomic, '120');
});

void test('a whole-response buyer refuses an inflated bill before signing or sending approval', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  let approvals = 0;
  f.intercept(async (...args) => {
    if (args[0].method === BATCH_METHODS.APPROVE) approvals++;
    const result = await f.service.exchange(...args);
    if (!('bill' in result)) return result;
    const inflated = String(BigInt(result.bill.chargedAtomic) + 1n);
    return {
      ...result,
      bill: {
        ...result.bill,
        chargedAtomic: inflated,
        cumulativeAtomic: inflated,
      },
    };
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(approvals, 0);
  assert.equal(f.rig.buyer.snapshot().cumulativeAtomic, '0');
});

void test('possible prompt send is never retried and remains reserved', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  let attempts = 0;
  f.intercept(async (...args) => {
    if (args[0].method === BATCH_METHODS.EXECUTE) {
      attempts++;
      await f.service.exchange(...args);
      throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
    }
    return f.service.exchange(...args);
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
  );
  assert.equal(attempts, 1);
  assert.equal(f.offers.generations(), 1);
  assert.equal(f.rig.buyer.snapshot().cumulativeAtomic, '0');
  await assert.rejects(f.rig.buyer.begin(f.rig.request(2)), {
    code: SESSION_CODES.BUSY,
  });
});

void test('verification refusal happens before opening a channel or sending a prompt', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  f.verification(async () => {
    throw new BatchChannelError(SESSION_CODES.UNVERIFIED);
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});

void test('shared seller reserves completion time before the host session expires', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  rig.time(rig.terms.expiresAt - 1000);
  let generations = 0;
  const run = await runBatchSellerExecution({
    seller: rig.seller(),
    request: rig.request(1),
    peer: rig.terms.buyerNodeId,
    verify: async () => {},
    outputTokens: 10,
    deadline: rig.terms.expiresAt + 1000,
    now: rig.now,
    signal: new AbortController().signal,
    errors: {
      timeout: () => new Error('synthetic timeout'),
      cancelled: () => new Error('synthetic cancellation'),
    },
    open: () => ({
      generate: async () => {
        generations++;
        return 'must not run';
      },
      measure: (generated) => ({
        inputTokens: 1,
        outputTokens: 'value' in generated ? 1 : 0,
        completed: 'value' in generated,
      }),
    }),
    nothing: { inputTokens: 1, outputTokens: 0, completed: false },
    charge: (outcome) => (outcome.outputTokens ? '40' : '0'),
  });
  assert.equal(generations, 0);
  assert.equal(run.settlement.chargedAtomic, '0');
  assert.ok('error' in run.generated);
});
