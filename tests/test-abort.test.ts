// The fake service's wait handles both past and future cancellation without leaving a live listener.
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { waitForTestAbort } from './support/test-abort';

void test('synthetic service observes cancellation that already happened', async () => {
  assert.equal(
    await Promise.race([
      waitForTestAbort(AbortSignal.abort()).then(() => true),
      yieldTurn().then(() => false),
    ]),
    true,
  );
});
void test('synthetic service waits for a future cancellation', async () => {
  const controller = new AbortController();
  let done = false;
  const pending = waitForTestAbort(controller.signal).then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  controller.abort();
  await pending;
  assert.equal(done, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
