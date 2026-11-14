// Query handoff waits retain existing active/financial quotas and discard cancelled work before ingress.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import {
  serveBatchChannelStream,
  type BatchStreamLimits,
} from '@gyblos/transport-iroh/batch-server';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';

import { batchDeferred } from './support/batch-deferred';

void test('batch handoff waits for actual release and does not replenish spent inference quota', async () => {
  const limiter = createPeerLimiter(() => 0, {
    ...TRANSPORT_LIMITS,
    requestsPerWindow: 1,
    globalRequestsPerWindow: 1,
  });
  const execution = limiter.enterQuery('buyer');
  assert.ok(execution);
  assert.equal(limiter.consume('buyer'), true);
  let granted = false;
  const waiting = limiter
    .waitQuery('buyer', new AbortController().signal)
    .then((release) => {
      granted = true;
      return release;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  assert.equal(limiter.enterQuery('buyer'), undefined);
  execution();
  const approval = await waiting;
  assert.ok(approval);
  assert.equal(limiter.consume('buyer'), false);
  assert.equal(limiter.enterQuery('buyer'), undefined);
  execution();
  assert.equal(
    limiter.enterQuery('buyer'),
    undefined,
    'Repeated release must not release the next owner.',
  );
  approval();
  const next = limiter.enterQuery('buyer');
  assert.ok(next);
  next();
});

void test('batch handoff has one waiter per peer and at most the existing global capacity', async () => {
  const limiter = createPeerLimiter(() => 0);
  const first = limiter.enterQuery('one');
  const second = limiter.enterQuery('two');
  assert.ok(first && second);
  const cancelOne = new AbortController();
  const cancelTwo = new AbortController();
  const one = limiter.waitQuery('one', cancelOne.signal);
  const two = limiter.waitQuery('two', cancelTwo.signal);
  assert.equal(
    await limiter.waitQuery('one', new AbortController().signal),
    undefined,
  );
  assert.equal(
    await limiter.waitQuery('three', new AbortController().signal),
    undefined,
  );
  first();
  const granted = await one;
  assert.ok(granted);
  assert.equal(
    limiter.enterQuery('three'),
    undefined,
    'Two active leases remain the global maximum.',
  );
  cancelTwo.abort();
  assert.equal(await two, undefined);
  second();
  granted();
});

void test('cancelled and pre-cancelled handoffs never take capacity or execute later', async () => {
  const limiter = createPeerLimiter(() => 0);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await limiter.waitQuery('buyer', cancelled.signal), undefined);
  const active = limiter.enterQuery('buyer');
  assert.ok(active);
  const controller = new AbortController();
  const waiting = limiter.waitQuery('buyer', controller.signal);
  controller.abort();
  assert.equal(await waiting, undefined);
  const replacement = limiter.waitQuery('buyer', new AbortController().signal);
  active();
  const release = await replacement;
  assert.ok(release);
  assert.equal(limiter.enterQuery('buyer'), undefined);
  release();
});

void test('ordinary execution release wakes a handoff without allowing another concurrent owner', async () => {
  const limiter = createPeerLimiter(() => 0);
  const execution = limiter.enter('buyer');
  assert.ok(execution);
  const waiting = limiter.waitQuery('buyer', new AbortController().signal);
  execution();
  const release = await waiting;
  assert.ok(release);
  assert.equal(limiter.enter('buyer'), undefined);
  release();
});

async function cancelledStream(limits: BatchStreamLimits, external: boolean) {
  const limiter = createPeerLimiter(() => 0);
  const held = limiter.enterQuery('buyer');
  assert.ok(held);
  const controller = new AbortController();
  const waiting = batchDeferred<void>();
  let closed = 0;
  let reads = 0;
  let calls = 0;
  const running = serveBatchChannelStream(
    {
      recv: {
        async readExact() {
          reads++;
          return [];
        },
        async read() {
          reads++;
          return [];
        },
      },
      send: {
        async writeAll() {
          assert.fail('No late response.');
        },
        async finish() {
          assert.fail('No late FIN.');
        },
      },
    },
    {
      async exchange() {
        calls++;
        assert.fail('No service before admission.');
      },
    },
    'buyer',
    () => {
      closed++;
    },
    controller.signal,
    (signal) => {
      waiting.resolve();
      return limiter.waitQuery('buyer', signal);
    },
    () => true,
    limits,
  );
  await waiting.promise;
  if (external) controller.abort();
  await running;
  assert.deepEqual({ reads, calls, closed }, { reads: 0, calls: 0, closed: 1 });
  held();
  const next = limiter.enterQuery('buyer');
  assert.ok(next, 'Cancelled handoff must not claim capacity after release.');
  next();
}

void test('batch handoff cancellation removes waiting work before parsing or financial effects', async () => {
  await cancelledStream({}, true);
});
void test('batch handoff expires within ingress and cannot start after its old owner releases', async () => {
  await cancelledStream({ ingressMs: 1 }, false);
});
void test('the absolute batch request deadline also cancels a waiting handoff', async () => {
  await cancelledStream({ requestMs: 1 }, false);
});
