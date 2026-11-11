// Queue review regressions preserve original price authority and bounded recovery preflight.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import {
  createBuyerRouter,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';

import { batchDeferred } from './support/batch-deferred';
import { routingQueueFixture } from './support/buyer-routing-queue';
import { multisellerSession } from './support/multiseller-session';

void test('a queued free quote cannot become paid without explicit higher-price permission', async (t) => {
  const source = await multisellerSession();
  const entered = batchDeferred<void>();
  const selected = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const router = createBuyerRouter({
    policy: parseBuyerRoutingPolicy({
      onBusy: BUYER_BUSY_POLICIES.WAIT,
      queueWaitMs: 2000,
    }),
    priceCeilings: {
      inputAtomicPerMtok: '9000000',
      outputAtomicPerMtok: '9000000',
    },
    unresolved: async () => false,
    reference: async () => undefined,
  });
  t.after(async () => {
    finish.resolve();
    await router.close();
    await source.close();
  });
  let changed = false;
  let quotes = 0;
  let paidCalls = 0;
  const ports: BuyerRoutePorts<string> = {
    select: async () => {
      const number = ++quotes;
      const quote = await source.offers[0]!.quote(
        number,
        changed
          ? {}
          : {
              maxAtomic: '0',
              prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
            },
      );
      if (number === 2) selected.resolve();
      return { nodeId: quote.offer.nodeId, quote };
    },
    free: async () => {
      entered.resolve();
      await finish.promise;
      return 'free';
    },
    paid: async () => {
      paidCalls++;
      return 'unexpected';
    },
  };
  const first = router.execute(ports, AbortSignal.timeout(5000));
  await entered.promise;
  const second = assert.rejects(
    router.execute(ports, AbortSignal.timeout(5000)),
    {
      code: BUYER_ROUTING_CODES.BUSY,
    },
  );
  await selected.promise;
  await setImmediate();
  changed = true;
  finish.resolve();
  await first;
  await second;
  assert.equal(quotes, 3);
  assert.equal(paidCalls, 0);
});
void test('queue expiry bounds recovery preflight after a grant and discards its late result', async (t) => {
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const checking = batchDeferred<void>();
  const release = batchDeferred<void>();
  let hold = false;
  const host = await routingQueueFixture(40, async () => {
    if (hold) {
      checking.resolve();
      await release.promise;
    }
    return false;
  });
  t.after(async () => {
    release.resolve();
    finish.resolve();
    await host.close();
  });
  const first = host.router.execute(
    {
      ...host.ports,
      paid: async () => {
        entered.resolve();
        await finish.promise;
        hold = true;
        return 'first';
      },
    },
    AbortSignal.timeout(3000),
  );
  await entered.promise;
  let ended = false;
  let executions = 0;
  const second = host.router
    .execute(
      {
        ...host.ports,
        paid: async () => {
          executions++;
          return 'unexpected';
        },
      },
      AbortSignal.timeout(3000),
    )
    .then(
      () => {
        ended = true;
        return undefined;
      },
      (error: unknown) => {
        ended = true;
        return error;
      },
    );
  await setImmediate();
  finish.resolve();
  await first;
  await checking.promise;
  await delay(100);
  const endedOnTime = ended;
  release.resolve();
  const error = await second;
  assert.equal(endedOnTime, true);
  assert.ok(error instanceof Error && 'code' in error);
  assert.equal(error.code, BUYER_ROUTING_CODES.QUEUE_TIMEOUT);
  await setImmediate();
  assert.equal(executions, 0);
  assert.equal(host.router.activeRequests(), 0);
});
