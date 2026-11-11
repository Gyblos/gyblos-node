// Queue cancellation and deadline boundaries preserve admission and never start a discarded prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';

import { batchDeferred } from './support/batch-deferred';
import { routingQueueFixture as fixture } from './support/buyer-routing-queue';

void test('uncertainty removes the queued request and never executes its prompt', async (t) => {
  let blocked = false;
  const host = await fixture(3000, async () => blocked);
  t.after(host.close);
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  t.after(() => finish.resolve());
  let calls = 0;
  const first = assert.rejects(
    host.router.execute(
      {
        ...host.ports,
        paid: async () => {
          calls++;
          entered.resolve();
          await finish.promise;
          blocked = true;
          throw new Error('Synthetic uncertain first request');
        },
      },
      AbortSignal.timeout(5000),
    ),
  );
  await entered.promise;
  const second = assert.rejects(
    host.router.execute(
      {
        ...host.ports,
        paid: async () => {
          calls++;
          return 'unexpected';
        },
      },
      AbortSignal.timeout(5000),
    ),
    { code: PAID_BUYER_CODES.UNRESOLVED },
  );
  await setImmediate();
  finish.resolve();
  await first;
  await second;
  assert.equal(calls, 1);
  assert.equal(host.router.activeRequests(), 0);
});
void test('one running request plus its waiter fills the unchanged global admission', async (t) => {
  const host = await fixture();
  t.after(host.close);
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  t.after(() => finish.resolve());
  const first = host.router.execute(
    {
      ...host.ports,
      paid: async () => {
        entered.resolve();
        await finish.promise;
        return 'first';
      },
    },
    AbortSignal.timeout(3000),
  );
  await entered.promise;
  const second = host.router.execute(host.ports, AbortSignal.timeout(3000));
  await setImmediate();
  assert.equal(host.router.activeRequests(), 2);
  await assert.rejects(
    host.router.execute(host.ports, AbortSignal.timeout(3000)),
    { code: BUYER_ROUTING_CODES.BUSY },
  );
  finish.resolve();
  await first;
  await second;
});
void test('queue timeout also bounds a fresh quote still being prepared and causes no execution', async (t) => {
  const host = await fixture(1000);
  t.after(host.close);
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const checking = batchDeferred<void>();
  const release = batchDeferred<void>();
  t.after(() => {
    finish.resolve();
    release.resolve();
  });
  let calls = 0;
  const first = host.router.execute(
    {
      ...host.ports,
      paid: async () => {
        entered.resolve();
        await finish.promise;
        return 'first';
      },
    },
    AbortSignal.timeout(3000),
  );
  await entered.promise;
  const second = assert.rejects(
    host.router.execute(
      {
        ...host.ports,
        select: async (...args) => {
          checking.resolve();
          await release.promise;
          return host.ports.select(...args);
        },
        paid: async () => {
          calls++;
          return 'unexpected';
        },
      },
      AbortSignal.timeout(3000),
    ),
    { code: BUYER_ROUTING_CODES.QUEUE_TIMEOUT },
  );
  await setImmediate();
  finish.resolve();
  await first;
  await checking.promise;
  await second;
  assert.equal(calls, 0);
  release.resolve();
});
void test('the queue clock ends at the prompt write boundary, allowing the original response deadline', async (t) => {
  const host = await fixture(1000);
  t.after(host.close);
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const sent = batchDeferred<void>();
  const answer = batchDeferred<void>();
  t.after(() => {
    finish.resolve();
    answer.resolve();
  });
  let failed: unknown;
  const first = host.router.execute(
    {
      ...host.ports,
      paid: async () => {
        entered.resolve();
        await finish.promise;
        return 'first';
      },
    },
    AbortSignal.timeout(4000),
  );
  await entered.promise;
  const second = host.router
    .execute(
      {
        ...host.ports,
        paid: async (_winner, signal, sending) => {
          sending?.();
          sent.resolve();
          await answer.promise;
          signal.throwIfAborted();
          return 'second';
        },
      },
      AbortSignal.timeout(4000),
    )
    .catch((error: unknown) => {
      failed = error;
      return undefined;
    });
  await setImmediate();
  finish.resolve();
  await first;
  await sent.promise;
  await delay(1100);
  assert.equal(failed, undefined);
  answer.resolve();
  assert.equal((await second)?.result, 'second');
});
void test('repeated remote busy shares the original queue deadline rather than resetting it on each quote', async (t) => {
  const host = await fixture(2500);
  t.after(host.close);
  let attempts = 0;
  await assert.rejects(
    host.router.execute(
      {
        ...host.ports,
        paid: async (winner) => {
          attempts++;
          throw new UnsentSellerBusyError(winner.nodeId);
        },
      },
      AbortSignal.timeout(6000),
    ),
    { code: BUYER_ROUTING_CODES.QUEUE_TIMEOUT },
  );
  assert.equal(attempts, 2);
});
