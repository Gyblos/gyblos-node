// Controls prior receipt work with barriers; no clocks, sockets, private state or payment effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterBuyerReceipts } from '@gyblos/buyer/receipt-drain';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test('a new request cannot dispatch while the previous receipt owns work', async () => {
  const receipt = deferred();
  const entered = deferred();
  let calls = 0;
  const pending = afterBuyerReceipts(
    () => {
      entered.resolve();
      return receipt.promise;
    },
    async () => ++calls,
    new AbortController().signal,
  );
  try {
    await Promise.race([entered.promise, pending]);
    assert.equal(calls, 0);
    receipt.resolve();
    assert.equal(await pending, 1);
  } finally {
    receipt.resolve();
    await pending;
  }
});

void test('cancelling a receipt wait cannot dispatch later when cleanup settles', async () => {
  const receipt = deferred();
  const controller = new AbortController();
  let calls = 0;
  const pending = afterBuyerReceipts(
    () => receipt.promise,
    async () => ++calls,
    controller.signal,
  );
  const rejected = assert.rejects(
    pending,
    (error) => error === controller.signal.reason,
  );
  controller.abort();
  await rejected;
  receipt.resolve();
  await receipt.promise;
  assert.equal(calls, 0);
});

void test('already cancelled requests do not execute even when receipts are idle', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    afterBuyerReceipts(
      async () => {},
      async () => ++calls,
      controller.signal,
    ),
    (error) => error === controller.signal.reason,
  );
  assert.equal(calls, 0);
});

void test('new receipt persistence stays in the background of the completed answer', async () => {
  const receipt = deferred();
  let current = Promise.resolve();
  const result = await afterBuyerReceipts(
    () => current,
    async () => {
      current = receipt.promise;
      return 1;
    },
    new AbortController().signal,
  );
  assert.equal(result, 1);
  let nextCalls = 0;
  const next = afterBuyerReceipts(
    () => current,
    async () => ++nextCalls,
    new AbortController().signal,
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(nextCalls, 0);
    receipt.resolve();
    assert.equal(await next, 1);
  } finally {
    receipt.resolve();
    await next;
  }
});

void test('an execution failure is returned once without retrying the operation', async () => {
  const failure = new Error('synthetic cut');
  let calls = 0;
  await assert.rejects(
    afterBuyerReceipts(
      async () => {},
      async () => {
        calls++;
        throw failure;
      },
      new AbortController().signal,
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});
