// A possibly sent request blocks every seller and free routing; financial recovery never repeats its prompt.
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { test } from 'node:test';

import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';
import { inspectBatchPool } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { multisellerLoopback } from './support/multiseller-session';

void test('failed delivery in A retains the global commitment and blocks B and free selection without retry', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  t.after(async () => {
    await buyer.close();
    await fixture.close();
  });
  fixture.offers[0]!.generate(async () => {
    throw new Error('Synthetic engine unavailable');
  });
  await assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(1),
      fixture.offers[0]!.input,
      new AbortController().signal,
    ),
  );
  assert.equal(await buyer.unresolved(), true);
  await assert.rejects(
    buyer.execute(
      await fixture.offers[1]!.quote(2),
      fixture.offers[1]!.input,
      new AbortController().signal,
    ),
    { code: SESSION_CODES.UNVERIFIED },
  );
  await assert.rejects(
    executeBuyerQuote({
      enter: () => () => {},
      unresolved: buyer.unresolved,
      select: async () => assert.fail('must not select'),
      free: async () => assert.fail('must not infer'),
      paid: async () => assert.fail('must not infer'),
    }),
    { code: PAID_BUYER_CODES.UNRESOLVED },
  );
  assert.equal(fixture.offers[0]!.generations(), 1);
  assert.equal(fixture.offers[1]!.generations(), 0);
  assert.equal((await inspectBatchPool(fixture.paths)).length, 1);
  assert.deepEqual(fixture.a.calls, ['deposit']);
  assert.deepEqual(fixture.b.calls, []);
});
void test('a failed durable intent write cannot construct financial services or lose the allocated budget', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    pool: async () => {
      const pool = await fixture.options.pool();
      return {
        ...pool,
        begin: async (...args) => {
          await chmod(fixture.paths.directory, 0o500);
          try {
            await pool.begin(...args);
          } finally {
            await chmod(fixture.paths.directory, 0o700);
          }
        },
      };
    },
  });
  t.after(async () => {
    await buyer.close();
    await fixture.close();
  });
  await assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(1),
      fixture.offers[0]!.input,
      new AbortController().signal,
    ),
  );
  assert.equal(fixture.prepared(), 0);
  assert.equal(fixture.offers[0]!.generations(), 0);
  assert.deepEqual(fixture.a.calls, []);
  const entry = (await inspectBatchPool(fixture.paths))[0]!;
  assert.equal(entry.terms.depositAtomic, '1000');
  assert.equal(entry.refundedAtomic, '0');
});

void test('one stalled seller cannot consume the closure opportunity of another healthy seller', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    operationMs: 1000,
  });
  t.after(async () => {
    fixture.stall(undefined);
    await buyer.close();
    await fixture.close();
  });
  await buyer.execute(
    await fixture.offers[0]!.quote(1),
    fixture.offers[0]!.input,
    new AbortController().signal,
  );
  await buyer.execute(
    await fixture.offers[1]!.quote(2),
    fixture.offers[1]!.input,
    new AbortController().signal,
  );
  fixture.stall(fixture.a.terms.sellerNodeId);
  assert.equal(await buyer.settle(AbortSignal.timeout(1000)), undefined);
  assert.ok(
    (fixture.observations.get(fixture.b.terms.sellerNodeId) ?? 0) > 0,
    'B must receive a closure opportunity before the aggregate deadline',
  );
  assert.equal(fixture.offers[0]!.generations(), 1);
  assert.equal(fixture.offers[1]!.generations(), 1);
});
