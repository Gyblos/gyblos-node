import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { multisellerLoopback } from './support/multiseller-session';

void test('a cancelled single-channel journal inspection leaves the key allowance untouched', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(() => fixture.close());
  const controller = new AbortController();
  let reservations = 0;
  const buyer = createBuyerSessionManager({
    ...fixture.options,
    inspect: async () => {
      controller.abort();
      return undefined;
    },
    authorizeRequest: async () => {
      reservations++;
      return undefined;
    },
    backend: async () => assert.fail('unexpected financial preparation'),
  });
  t.after(() => buyer.close());
  const offer = fixture.offers[0]!;
  await assert.rejects(
    buyer.execute(await offer.quote(1), offer.input, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(reservations, 0);
  assert.deepEqual(fixture.a.calls, []);
});

void test('an aborted authorization finishes its exact release before the manager admits another turn', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(() => fixture.close());
  const controller = new AbortController();
  const writing = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const releaseStarted = batchDeferred<void>();
  const releaseDone = batchDeferred<void>();
  let releases = 0;
  const buyer = createBuyerSessionManager({
    ...fixture.options,
    inspect: async () => undefined,
    authorizeRequest: async () => {
      writing.resolve();
      await finish.promise;
      return async () => {
        releases++;
        releaseStarted.resolve();
        await releaseDone.promise;
      };
    },
    backend: async () => assert.fail('unexpected financial preparation'),
  });
  t.after(() => buyer.close());
  const offer = fixture.offers[0]!;
  const quote = await offer.quote(1);
  const cancelled = assert.rejects(
    buyer.execute(quote, offer.input, controller.signal),
    { name: 'AbortError' },
  );
  await writing.promise;
  controller.abort();
  finish.resolve();
  await releaseStarted.promise;
  try {
    await assert.rejects(
      buyer.execute(quote, offer.input, new AbortController().signal),
      { code: SESSION_CODES.BUSY },
    );
  } finally {
    releaseDone.resolve();
  }
  await cancelled;
  assert.equal(releases, 1);
  assert.deepEqual(fixture.a.calls, []);
});

void test('each cached single-channel turn needs its own authorization and the first reserves once', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(() => fixture.close());
  const offer = fixture.offers[0]!;
  const inspect = () => inspectBatchSession(fixture.a.buyerOptions.paths);
  let reservations = 0;
  let constructions = 0;
  const deny = new Error('synthetic refusal');
  const buyer = createBuyerSessionManager({
    ...fixture.options,
    inspect,
    authorizeRequest: async () => {
      reservations++;
      if (reservations === 2) throw deny;
      return undefined;
    },
    backend: async () => {
      constructions++;
      assert.equal(reservations, 1);
      return {
        inspect,
        create: async () => fixture.a.buyer,
        observe: fixture.a.sellerOptions.observe,
      };
    },
  });
  t.after(() => buyer.close());
  await buyer.execute(
    await offer.quote(1),
    offer.input,
    AbortSignal.timeout(3000),
  );
  assert.equal(reservations, 1);
  await assert.rejects(
    buyer.execute(await offer.quote(2), offer.input, AbortSignal.timeout(3000)),
    (error) => error === deny,
  );
  assert.equal(reservations, 2);
  assert.equal(constructions, 1);
  assert.equal(offer.generations(), 1);
});
