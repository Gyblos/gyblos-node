// Real loopback preparation expires before a prompt write; no payment RPC or engine process is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import {
  createBuyerRouter,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';

import { batchDeferred } from './support/batch-deferred';
import { multisellerLoopback } from './support/multiseller-session';

void test('paid transport preparation preserves the unsent queue timeout and never generates a second prompt', async (t) => {
  const fixture = await multisellerLoopback();
  const finish = batchDeferred<void>();
  const entered = batchDeferred<void>();
  const paused = batchDeferred<void>();
  const preflight = batchDeferred<void>();
  let checks = 0;
  const resume = batchDeferred<void>();
  let armed = false;
  let streams = 0;
  const callbacks = new Map<string, () => void>();
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    endpoint: {
      ...fixture.options.endpoint,
      connect: async (...args) => {
        const connection = await fixture.options.endpoint.connect(...args);
        return {
          remoteId: () => connection.remoteId(),
          paths: () => connection.paths(),
          close: (...input) => connection.close(...input),
          closed: () => connection.closed(),
          openBi: async () => {
            if (armed && ++streams === 3) {
              paused.resolve();
              await resume.promise;
            }
            return connection.openBi();
          },
        };
      },
    },
    transport: {
      beforeExecute: (request) =>
        callbacks.get(request.quote.offer.requestId)?.(),
    },
  });
  const router = createBuyerRouter({
    policy: parseBuyerRoutingPolicy({
      onBusy: BUYER_BUSY_POLICIES.WAIT,
      queueWaitMs: 1000,
    }),
    pinnedNodeId: fixture.a.terms.sellerNodeId,
    priceCeilings: fixture.offers[0]!.base.prices,
    unresolved: async () => {
      const blocked = await buyer.unresolved();
      if (++checks === 3) preflight.resolve();
      return blocked;
    },
    reference: async () => fixture.offers[0]!.base.prices,
  });
  t.after(async () => {
    finish.resolve();
    resume.resolve();
    await router.close();
    await buyer.close();
    await fixture.close();
  });
  await buyer.execute(
    await fixture.offers[0]!.quote(1),
    fixture.offers[0]!.input,
    AbortSignal.timeout(5000),
  );
  let quotes = 1;
  const ports: BuyerRoutePorts<string> = {
    select: async () => {
      const quote = await fixture.offers[0]!.quote(++quotes);
      return { nodeId: quote.offer.nodeId, quote };
    },
    free: async () => assert.fail('priced quotes only'),
    paid: async (winner, signal, sending) => {
      if (sending) callbacks.set(winner.quote.offer.requestId, sending);
      try {
        return (
          await buyer.execute(winner.quote, fixture.offers[0]!.input, signal)
        ).value.text;
      } finally {
        callbacks.delete(winner.quote.offer.requestId);
      }
    },
  };
  const first = router.execute(
    {
      ...ports,
      paid: async () => {
        entered.resolve();
        await finish.promise;
        return 'first';
      },
    },
    AbortSignal.timeout(5000),
  );
  await entered.promise;
  const second = assert.rejects(
    router.execute(ports, AbortSignal.timeout(5000)),
    {
      code: BUYER_ROUTING_CODES.QUEUE_TIMEOUT,
    },
  );
  await preflight.promise;
  await setImmediate();
  armed = true;
  finish.resolve();
  await first;
  await paused.promise;
  await second;
  assert.equal(fixture.offers[0]!.generations(), 1);
  assert.equal(fixture.offers[1]!.generations(), 0);
  assert.deepEqual(fixture.a.calls, ['deposit']);
  resume.resolve();
});
