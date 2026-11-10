// Buyer/seller integration over real loopback streams with synthetic financial/engine services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import {
  BATCH_METHODS,
  BatchChannelError,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { batchLoopback } from './support/batch-loopback';
import { sessionRig } from './support/batch-session';

async function fixture() {
  const rig = await sessionRig();
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const service = createSellerBatchSession({
    session: rig.seller(),
    terms: rig.terms,
    offers: () => [offers.live],
    now: rig.now,
  });
  let intercept: ((request: BatchChannelRequest) => Promise<void>) | undefined;
  const wire = await batchLoopback(
    {
      async exchange(...args) {
        const response = await service.exchange(...args);
        await intercept?.(args[0]);
        return response;
      },
    },
    rig.terms,
  );
  let verifications = 0;
  const buyer = createBuyerBatchSession({
    ...wire,
    terms: rig.terms,
    buyer: rig.buyer,
    now: rig.now,
    meter: offers.meter,
    unresolved: async () => false,
    verify: async (quote) => {
      verifications++;
      assert.equal(quote.offer.owner, rig.terms.owner);
    },
    observe: rig.sellerOptions.observe,
  });
  return {
    rig,
    offers,
    service,
    buyer,
    verifications: () => verifications,
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
    async close() {
      await buyer.disconnect();
      await buyer.settled();
      await wire.close();
      await rig.dispose();
    },
  };
}
void test('shared quote routing executes three requests through one zero-charge batch deposit', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (let index = 1; index <= 3; index++) {
    const quote = await f.offers.quote(index);
    const run = await executeBuyerQuote({
      enter: () => () => {},
      unresolved: async () => false,
      select: async () => ({ nodeId: f.rig.terms.sellerNodeId, quote }),
      free: async () => assert.fail('priced quote must not use free mode'),
      paid: async () => f.buyer.execute(quote, f.offers.input),
    });
    assert.equal(run.result.text, 'ok!');
  }
  assert.equal(f.offers.generations(), 3);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '120');
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.ok(f.verifications() >= 3);
  await f.buyer.disconnect();
  await f.buyer.settled();
  f.rig.time(f.rig.now() + 1001);
  assert.equal((await f.rig.seller().tick())?.chargedAtomic, '120');
  assert.equal(f.rig.seller().snapshot().state, SESSION_STATES.CLOSED);
  assert.deepEqual(f.rig.calls, ['deposit', 'refund']);
});
void test('lost approval ACK recovers only the signed financial approval, never the prompt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let lost = true;
  f.intercept(async (request) => {
    if (lost && request.method === BATCH_METHODS.APPROVE) {
      lost = false;
      throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
    }
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: SESSION_CODES.UNAVAILABLE },
  );
  assert.equal(f.offers.generations(), 1);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '40');
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal(f.offers.generations(), 1);
  assert.equal(
    (await f.buyer.execute(await f.offers.quote(2), f.offers.input)).text,
    'ok!',
  );
  assert.equal(f.offers.generations(), 2);
  assert.deepEqual(f.rig.calls, ['deposit']);
});
void test('busy and stale readiness refuse before any deposit or generation', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.offers.busy(true);
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: PAID_EXECUTION_CODES.BUSY },
  );
  f.offers.busy(false);
  f.offers.down(true);
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(2), f.offers.input),
    { code: PAID_EXECUTION_CODES.ENGINE },
  );
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});

void test('unsupported input and reasoning are rejected before signing an opening', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const original = f.rig.buyer.open.bind(f.rig.buyer);
  let openings = 0;
  t.mock.method(f.rig.buyer, 'open', async () => {
    openings++;
    return original();
  });
  const quote = await f.offers.quote(1);
  await assert.rejects(
    f.buyer.execute(quote, {
      ...f.offers.input,
      messages: [...f.offers.input.messages, ...f.offers.input.messages],
    }),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  await assert.rejects(
    f.buyer.execute(
      await f.offers.quote(2, { reasoning: REASONING_LEVELS.LOW }),
      f.offers.input,
    ),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  assert.equal(openings, 0);
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('expired or invalidly signed quotes cannot open a deposit', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const quote = await f.offers.quote(1);
  await assert.rejects(
    f.buyer.execute(
      { ...quote, signature: Buffer.alloc(64).toString('base64') },
      f.offers.input,
    ),
    { code: PAID_EXECUTION_CODES.SIGNATURE },
  );
  f.rig.time(quote.offer.expiresAt);
  await assert.rejects(f.buyer.execute(quote, f.offers.input), {
    code: PAID_EXECUTION_CODES.EXPIRED,
  });
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('an already used execution id never generates or charges again', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const quote = await f.offers.quote(1);
  await f.buyer.execute(quote, f.offers.input);
  await assert.rejects(f.buyer.execute(quote, f.offers.input), {
    code: SESSION_CODES.BINDING,
  });
  assert.equal(f.offers.generations(), 1);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '40');
});
void test('the buyer refuses mismatched usage before creating any cumulative voucher', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const original = f.service.exchange.bind(f.service);
  t.mock.method(
    f.service,
    'exchange',
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if ('value' in result) result.value.usage.outputTokens = 2;
      return result;
    },
  );
  const approve = t.mock.method(f.rig.buyer, 'approve');
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(approve.mock.callCount(), 0);
  assert.equal(f.offers.generations(), 1);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '0');
});
void test('an engine failure after the prompt never falls back or authorizes another request', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.offers.generate(async () => {
    throw new Error('Synthetic provider failure');
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: PAID_EXECUTION_CODES.ENGINE },
  );
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(2), f.offers.input),
    { code: SESSION_CODES.BUSY },
  );
  assert.equal(f.offers.generations(), 1);
  assert.equal(await f.rig.buyer.recoverApproval(), undefined);
  assert.deepEqual(f.rig.calls, ['deposit']);
});
void test('wrong authenticated peer is rejected before reading any SDK opening', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    f.service.exchange(
      {
        version: 1,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.OPEN,
        params: {
          quote: await f.offers.quote(1),
          payload: 'invalid synthetic SDK payload',
        },
      },
      '56'.repeat(32),
      new AbortController().signal,
    ),
    { code: PAID_EXECUTION_CODES.PEER },
  );
  assert.deepEqual(f.rig.calls, []);
  assert.equal(f.offers.generations(), 0);
});
void test('zero price remains on the transaction-free route and cannot enter a batch session', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const quote = await f.offers.quote(1, {
    prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    maxAtomic: '0',
  });
  await assert.rejects(f.buyer.execute(quote, f.offers.input), {
    code: PAID_EXECUTION_CODES.NOT_PAID,
  });
  assert.deepEqual(f.rig.calls, []);
  assert.equal(f.offers.generations(), 0);
});
