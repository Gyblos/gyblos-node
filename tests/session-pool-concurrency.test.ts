// Two seller channels run independently; durable live ownership never becomes a recovery operation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { multisellerLoopback } from './support/multiseller-session';

function completed() {
  return {
    text: 'ok!',
    finishReason: ENGINE_DONE_REASONS.STOP,
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      totalDurationNs: 0,
      loadDurationNs: 0,
      inputDurationNs: 0,
      outputDurationNs: 0,
    },
  };
}
void test('B completes while A is generating and A is reused afterward without another deposit', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const started = batchDeferred<void>();
  const finish = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => {
    started.resolve();
    await finish.promise;
    return completed();
  });
  t.after(async () => {
    finish.resolve();
    await buyer.close();
    await fixture.close();
  });
  const a = buyer.execute(
    await fixture.offers[0]!.quote(1),
    fixture.offers[0]!.input,
    AbortSignal.timeout(3000),
  );
  await started.promise;
  try {
    const b = await buyer.execute(
      await fixture.offers[1]!.quote(2),
      fixture.offers[1]!.input,
      AbortSignal.timeout(3000),
    );
    assert.equal(b.value.text, 'ok!');
    await assert.rejects(
      buyer.execute(
        await fixture.offers[0]!.quote(3),
        fixture.offers[0]!.input,
        AbortSignal.timeout(3000),
      ),
      { code: SESSION_CODES.BUSY },
    );
    assert.deepEqual(fixture.a.calls, ['deposit']);
    assert.deepEqual(fixture.b.calls, ['deposit']);
  } finally {
    finish.resolve();
    await a;
  }
  await buyer.execute(
    await fixture.offers[0]!.quote(4),
    fixture.offers[0]!.input,
    AbortSignal.timeout(3000),
  );
  assert.equal(fixture.offers[0]!.generations(), 2);
  assert.deepEqual(fixture.a.calls, ['deposit']);
});
void test('preflight reports no unresolved obligation for a live owned request and settlement remains exclusive', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const started = batchDeferred<void>();
  const finish = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => {
    started.resolve();
    await finish.promise;
    return completed();
  });
  t.after(async () => {
    finish.resolve();
    await buyer.close();
    await fixture.close();
  });
  const a = buyer.execute(
    await fixture.offers[0]!.quote(1),
    fixture.offers[0]!.input,
    AbortSignal.timeout(3000),
  );
  await started.promise;
  try {
    assert.equal(await buyer.unresolved(), false);
    await assert.rejects(buyer.settle(AbortSignal.timeout(1000)), {
      code: SESSION_CODES.BUSY,
    });
  } finally {
    finish.resolve();
    await a;
  }
});
void test('remote busy before a prompt clears only its unsent intent and permits another seller', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  t.after(async () => {
    await buyer.close();
    await fixture.close();
  });
  fixture.offers[0]!.busy(true);
  await assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(1),
      fixture.offers[0]!.input,
      AbortSignal.timeout(3000),
    ),
    { name: 'UnsentSellerBusyError' },
  );
  assert.equal(await buyer.unresolved(), false);
  assert.equal(fixture.offers[0]!.generations(), 0);
  assert.deepEqual(fixture.a.calls, []);
  fixture.offers[0]!.busy(false);
  await buyer.execute(
    await fixture.offers[0]!.quote(2),
    fixture.offers[0]!.input,
    AbortSignal.timeout(3000),
  );
  fixture.offers[0]!.busy(true);
  await assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(3),
      fixture.offers[0]!.input,
      AbortSignal.timeout(3000),
    ),
    { name: 'UnsentSellerBusyError' },
  );
  assert.equal(await buyer.unresolved(), false);
  await buyer.execute(
    await fixture.offers[1]!.quote(4),
    fixture.offers[1]!.input,
    AbortSignal.timeout(3000),
  );
  assert.deepEqual(fixture.a.calls, ['deposit']);
});
void test('uncertainty in A preserves an already sent B response and blocks every new request', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const aStarted = batchDeferred<void>();
  const bStarted = batchDeferred<void>();
  const failA = batchDeferred<void>();
  const finishB = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => {
    aStarted.resolve();
    await failA.promise;
    throw new Error('Synthetic interrupted A');
  });
  fixture.offers[1]!.generate(async () => {
    bStarted.resolve();
    await finishB.promise;
    return completed();
  });
  t.after(async () => {
    failA.resolve();
    finishB.resolve();
    await buyer.close();
    await fixture.close();
  });
  const a = buyer.execute(
    await fixture.offers[0]!.quote(1),
    fixture.offers[0]!.input,
    AbortSignal.timeout(3000),
  );
  const rejected = assert.rejects(a);
  await aStarted.promise;
  const b = buyer.execute(
    await fixture.offers[1]!.quote(2),
    fixture.offers[1]!.input,
    AbortSignal.timeout(3000),
  );
  await bStarted.promise;
  failA.resolve();
  await rejected;
  assert.equal(await buyer.unresolved(), true);
  finishB.resolve();
  assert.equal((await b).value.text, 'ok!');
  await assert.rejects(
    buyer.execute(
      await fixture.offers[1]!.quote(3),
      fixture.offers[1]!.input,
      AbortSignal.timeout(3000),
    ),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(fixture.offers[0]!.generations(), 1);
  assert.equal(fixture.offers[1]!.generations(), 1);
});

void test('concurrent new sellers cannot both allocate the same remaining shared deposit authority', async (t) => {
  const fixture = await multisellerLoopback('1000');
  const buyer = createBuyerSessionPool(fixture.options);
  t.after(async () => {
    await buyer.close();
    await fixture.close();
  });
  const quotes = await Promise.all(
    fixture.offers.map((offer, index) => offer.quote(index + 1)),
  );
  const results = await Promise.allSettled(
    quotes.map((quote, index) =>
      buyer.execute(
        quote,
        fixture.offers[index]!.input,
        AbortSignal.timeout(3000),
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const failed = results.find((result) => result.status === 'rejected');
  assert.ok(failed && failed.status === 'rejected');
  assert.equal(failed.reason.code, SESSION_CODES.LIMIT);
  assert.equal(
    [...fixture.a.calls, ...fixture.b.calls].filter(
      (call) => call === 'deposit',
    ).length,
    1,
  );
  assert.equal(
    fixture.offers.reduce((sum, offer) => sum + offer.generations(), 0),
    1,
  );
});
void test('A becoming uncertain cancels B held immediately before its first prompt write', async (t) => {
  const fixture = await multisellerLoopback();
  const paused = batchDeferred<void>();
  const resume = batchDeferred<void>();
  const aStarted = batchDeferred<void>();
  const failA = batchDeferred<void>();
  fixture.offers[0]!.generate(async () => {
    aStarted.resolve();
    await failA.promise;
    throw new Error('Synthetic A failure');
  });
  let bStreams = 0;
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
            if (
              args[0].id().toString() === fixture.b.terms.sellerNodeId &&
              ++bStreams === 3
            ) {
              paused.resolve();
              await resume.promise;
            }
            return connection.openBi();
          },
        };
      },
    },
  });
  t.after(async () => {
    resume.resolve();
    failA.resolve();
    await buyer.close();
    await fixture.close();
  });
  const a = assert.rejects(
    buyer.execute(
      await fixture.offers[0]!.quote(1),
      fixture.offers[0]!.input,
      AbortSignal.timeout(3000),
    ),
  );
  await aStarted.promise;
  const b = assert.rejects(
    buyer.execute(
      await fixture.offers[1]!.quote(2),
      fixture.offers[1]!.input,
      AbortSignal.timeout(3000),
    ),
  );
  await paused.promise;
  failA.resolve();
  await a;
  await b;
  assert.equal(fixture.offers[1]!.generations(), 0);
  resume.resolve();
});
