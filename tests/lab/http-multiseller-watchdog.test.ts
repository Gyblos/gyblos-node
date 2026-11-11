// A missing execution phase must fail boundedly instead of stranding temporary process resources.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { httpMultiPhase } from '../support/http-multiseller-phase';
import { within } from '../support/test-deadline';

void test('an already cancelled acceptance phase cannot wait forever', async () => {
  await assert.rejects(
    within(
      httpMultiPhase(
        new Promise<void>(() => {}),
        new Promise(() => {}),
        AbortSignal.abort(),
      ),
      30,
    ),
    { name: 'AbortError' },
  );
});
void test('cancellation releases a barrier whose expected transport operation never starts', async () => {
  const controller = new AbortController();
  const result = assert.rejects(
    within(
      httpMultiPhase(
        new Promise<void>(() => {}),
        new Promise(() => {}),
        controller.signal,
      ),
      30,
    ),
    { name: 'AbortError' },
  );
  controller.abort();
  await result;
});
void test('a completed request cannot leave an unreachable acceptance phase pending', async () => {
  await assert.rejects(
    within(
      httpMultiPhase(
        new Promise<void>(() => {}),
        Promise.resolve(),
        new AbortController().signal,
      ),
      30,
    ),
    { message: 'Synthetic execution did not reach expected phase' },
  );
});
