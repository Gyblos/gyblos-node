import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reserveApiKey } from '@gyblos/buyer/api-key-execution';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import {
  BUYER_KEY_CODES,
  BuyerApiKeyError,
} from '@gyblos/protocol/buyer-api-keys';
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

void test('switching sellers preserves delegated key refusals before closing the previous channel', async (t) => {
  const f = await multisellerLoopback('20000', '20000');
  t.after(() => f.close());
  const inspect = () => inspectBatchSession(f.a.buyerOptions.paths);
  let refusal: BuyerApiKeyError | undefined;
  const buyer = createBuyerSessionManager({
    ...f.options,
    inspect,
    switchingAllowed: async () => true,
    authorizeRequest: async () => {
      if (refusal) throw refusal;
      return undefined;
    },
    backend: async () => ({
      inspect,
      create: async () => f.a.buyer,
      observe: f.a.sellerOptions.observe,
      renew: async () => assert.fail('unexpected renewal'),
    }),
  });
  t.after(() => buyer.close());
  const a = f.offers[0]!;
  const b = f.offers[1]!;
  await buyer.execute(await a.quote(1), a.input, AbortSignal.timeout(3000));
  const calls = [...f.a.calls];
  const snapshot = f.a.buyer.snapshot();
  for (const code of [BUYER_KEY_CODES.REVOKED, BUYER_KEY_CODES.REVIEW]) {
    refusal = new BuyerApiKeyError(code);
    await assert.rejects(
      buyer.execute(await b.quote(2), b.input, AbortSignal.timeout(3000)),
      (error) => {
        assert.equal(classifyPaidError(error)?.code, code);
        assert.equal(
          classifyPaidError(error)?.status,
          code === BUYER_KEY_CODES.REVOKED ? 403 : 503,
        );
        return error === refusal;
      },
    );
    assert.deepEqual(f.a.calls, calls);
    assert.deepEqual(f.a.buyer.snapshot(), snapshot);
    assert.equal(b.generations(), 0);
  }
});

void test('cancelling a durable pooled key reservation releases it once before channel preparation', async (t) => {
  const f = await multisellerLoopback();
  t.after(() => f.close());
  const scope = {
    network: f.a.terms.network,
    mint: f.a.terms.mint,
    payer: f.a.terms.buyer,
  };
  let stored: string | undefined;
  const files = {
    read: async () => stored,
    write: async (value: string) => {
      stored = value;
    },
  };
  const keys = await createBuyerApiKeys({ scope, files });
  t.after(() => keys.close());
  const key = await keys.create('Synthetic tool', '1000');
  const op = keys.operation(key.id);
  const controller = new AbortController();
  const reason = new Error('synthetic cancellation after reservation');
  let releases = 0;
  const buyer = createBuyerSessionPool({
    ...f.options,
    openingSupportsBlocks: false,
    endpoint: {
      ...f.options.endpoint,
      connect: async () => assert.fail('unexpected seller preparation'),
    },
    authorizeRequest: async (quote, signal) => {
      await reserveApiKey(op, quote, signal);
      assert.equal(
        (await keys.snapshot()).keys[0]?.reservedAtomic,
        quote.offer.maxAtomic,
      );
      controller.abort(reason);
      return async () => {
        releases++;
        await op.releaseUnsent();
      };
    },
  });
  t.after(() => buyer.close());
  const offer = f.offers[0]!;
  await assert.rejects(
    buyer.execute(await offer.quote(1), offer.input, controller.signal),
    (error) => error === reason,
  );
  op.abandon();
  assert.equal(releases, 1);
  assert.equal(f.prepared(), 0);
  assert.equal(offer.generations(), 0);
  assert.deepEqual(await f.options.inspect(), []);
  const reopened = await createBuyerApiKeys({ scope, files });
  t.after(() => reopened.close());
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.blocked, false);
  assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
  assert.equal(snapshot.keys[0]?.spentAtomic, '0');
});
