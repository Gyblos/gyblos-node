// An asynchronous preflight may never clear a newer uncertain obligation or enable a free prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { createBuyerRouter } from '@gyblos/node/buyer-routing';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';

import { batchDeferred } from './support/batch-deferred';
import { multisellerLoopback } from './support/multiseller-session';

void test('a stale preflight scan cannot clear uncertainty observed after it inspected live A', async (t) => {
  const fixture = await multisellerLoopback();
  const paused = batchDeferred<void>();
  const resume = batchDeferred<void>();
  const aStarted = batchDeferred<void>();
  const failA = batchDeferred<void>();
  let armed = false;
  let checks = 0;
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    pool: async () => {
      const pool = await fixture.options.pool();
      return {
        ...pool,
        resolve: async (...args) => {
          if (
            armed &&
            args[0] === fixture.b.terms.sellerNodeId &&
            ++checks === 2
          ) {
            paused.resolve();
            await resume.promise;
          }
          return pool.resolve(...args);
        },
      };
    },
  });
  const router = createBuyerRouter({
    policy: parseBuyerRoutingPolicy(),
    priceCeilings: {
      inputAtomicPerMtok: '9000000',
      outputAtomicPerMtok: '9000000',
    },
    unresolved: buyer.unresolved,
    reference: async () => undefined,
  });
  t.after(async () => {
    resume.resolve();
    failA.resolve();
    await router.close();
    await buyer.close();
    await fixture.close();
  });
  for (const [index, offer] of fixture.offers.entries())
    await buyer.execute(
      await offer.quote(index + 1),
      offer.input,
      AbortSignal.timeout(3000),
    );
  await fixture.b.seller().close();
  await buyer.reconcile(AbortSignal.timeout(3000));
  fixture.offers[0]!.generate(async () => {
    aStarted.resolve();
    await failA.promise;
    throw new Error('Synthetic A failure');
  });
  const aDone = assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(3),
      fixture.offers[0]!.input,
      AbortSignal.timeout(3000),
    ),
  );
  await aStarted.promise;
  armed = true;
  const quote = await fixture.offers[1]!.quote(4, {
    maxAtomic: '0',
    prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  });
  let writes = 0;
  const free = router
    .execute(
      {
        select: async () => ({ nodeId: quote.offer.nodeId, quote }),
        paid: async () => assert.fail('free quote'),
        free: async () => {
          buyer.checkBeforeExternalExecution();
          writes++;
          return 'synthetic answer';
        },
      },
      AbortSignal.timeout(3000),
    )
    .then(
      () => true,
      () => false,
    );
  await paused.promise;
  failA.resolve();
  const wait = AbortSignal.timeout(3000);
  while (true) {
    try {
      buyer.checkBeforeExternalExecution();
    } catch {
      break;
    }
    wait.throwIfAborted();
    await setImmediate();
  }
  resume.resolve();
  const delivered = await free;
  await aDone;
  assert.equal(
    writes,
    0,
    'a newer uncertain obligation must survive the stale scan',
  );
  assert.equal(delivered, false);
  assert.equal(await buyer.unresolved(), true);
});
