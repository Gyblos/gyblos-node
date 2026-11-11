// Shared router decisions precede prompt execution, with bounded per-seller ownership and immutable prices.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import {
  createBuyerRouter,
  UnsentSellerBusyError,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';

import { batchDeferred } from './support/batch-deferred';
import { multisellerSession } from './support/multiseller-session';

async function fixture(policy: unknown = undefined, pinned = false) {
  const source = await multisellerSession();
  const quotes = await Promise.all(
    source.offers.map((offer, index) => offer.quote(index + 1)),
  );
  const router = createBuyerRouter({
    policy: parseBuyerRoutingPolicy(policy),
    pinnedNodeId: pinned ? quotes[0]!.offer.nodeId : undefined,
    priceCeilings: {
      inputAtomicPerMtok: '9000000',
      outputAtomicPerMtok: '9000000',
    },
    unresolved: async () => false,
    reference: async () => quotes[0]!.offer.prices,
  });
  const ports: BuyerRoutePorts<string> = {
    select: async (excluded) => {
      const quote = quotes.find((quote) => !excluded.has(quote.offer.nodeId));
      assert.ok(quote);
      return { nodeId: quote.offer.nodeId, quote };
    },
    free: async () => assert.fail('priced quotes only'),
    paid: async (winner) => winner.nodeId,
  };
  return {
    source,
    quotes,
    router,
    ports,
    close: async () => {
      await router.close();
      await source.close();
    },
  };
}
void test('router redirects a locally busy winner before execution and preserves per-request prices', async (t) => {
  const host = await fixture();
  t.after(host.close);
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  t.after(() => finish.resolve());
  const first = host.router.execute(
    {
      ...host.ports,
      paid: async (winner) => {
        entered.resolve();
        await finish.promise;
        return winner.nodeId;
      },
    },
    AbortSignal.timeout(3000),
  );
  await entered.promise;
  try {
    const second = await host.router.execute(
      {
        ...host.ports,
        select: async (...args) => {
          if (args[0].has(host.quotes[0]!.offer.nodeId))
            assert.deepEqual(
              args[2].priceCeilings,
              host.quotes[0]!.offer.prices,
            );
          return host.ports.select(...args);
        },
      },
      AbortSignal.timeout(3000),
    );
    assert.equal(second.result, host.quotes[1]!.offer.nodeId);
  } finally {
    finish.resolve();
    await first;
  }
});
void test('reject and a protected pin refuse a busy winner instead of selecting another seller', async (t) => {
  for (const policy of [{ onBusy: BUYER_BUSY_POLICIES.REJECT }, {}]) {
    const host = await fixture(policy, true);
    t.after(host.close);
    await assert.rejects(
      host.router.execute(
        {
          ...host.ports,
          paid: async (winner) => {
            throw new UnsentSellerBusyError(winner.nodeId);
          },
        },
        AbortSignal.timeout(3000),
      ),
      { code: BUYER_ROUTING_CODES.BUSY },
    );
  }
});
void test('explicit pinned fallback removes the pin and remote preflight busy never executes the original prompt', async (t) => {
  const host = await fixture({ allowPinnedFallback: true }, true);
  t.after(host.close);
  let attempts = 0;
  const result = await host.router.execute(
    {
      ...host.ports,
      select: async (excluded, signal, policy) => {
        if (!excluded.size)
          throw new UnsentSellerBusyError(host.quotes[0]!.offer.nodeId);
        assert.equal(policy.pinnedNodeId, undefined);
        return host.ports.select(excluded, signal, policy);
      },
      paid: async (winner) => {
        attempts++;
        return winner.nodeId;
      },
    },
    AbortSignal.timeout(3000),
  );
  assert.equal(result.result, host.quotes[1]!.offer.nodeId);
  assert.equal(attempts, 1);
});
void test('a possibly sent failure ends the request without fallback', async (t) => {
  const host = await fixture();
  t.after(host.close);
  let attempts = 0;
  await assert.rejects(
    host.router.execute(
      {
        ...host.ports,
        paid: async () => {
          attempts++;
          throw new Error('Synthetic sent failure');
        },
      },
      AbortSignal.timeout(3000),
    ),
    /Synthetic sent failure/,
  );
  assert.equal(attempts, 1);
});
