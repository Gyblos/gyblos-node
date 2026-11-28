// A missing execution phase must fail boundedly instead of stranding temporary process resources.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchDeferred } from '../support/batch-deferred';
import { HTTP_MULTI } from '../support/http-multiseller-constants';
import {
  cancelAfterBody,
  httpMultiPhase,
} from '../support/http-multiseller-phase';
import { NativeTestDeadlineError, within } from '../support/test-deadline';

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

void test('an early queued refusal owns its single failure and cancels the request', async () => {
  const controller = new AbortController();
  await assert.rejects(
    cancelAfterBody(
      new Promise<void>(() => {}),
      Promise.resolve(),
      controller,
      AbortSignal.timeout(1000),
    ),
    { message: 'Synthetic execution did not reach expected phase' },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(controller.signal.aborted);
});
void test('a socket failure is not evidence of the requested cancellation', async () => {
  const controller = new AbortController();
  await assert.rejects(
    cancelAfterBody(
      Promise.resolve(),
      Promise.reject(new Error('private socket detail')),
      controller,
      AbortSignal.timeout(1000),
    ),
    { message: 'The queued request must stop through its cancellation signal' },
  );
});
void test('host cancellation before the body preserves its error when the request stalls', async () => {
  const controller = new AbortController();
  await assert.rejects(
    within(
      cancelAfterBody(
        new Promise(() => {}),
        new Promise(() => {}),
        controller,
        AbortSignal.abort(),
      ),
      250,
    ),
    { name: 'AbortError' },
  );
  assert.ok(controller.signal.aborted);
});
void test('host cancellation during cleanup releases an already cancelled stalled request', async () => {
  const controller = new AbortController();
  const host = new AbortController();
  controller.signal.addEventListener('abort', () => host.abort(), {
    once: true,
  });
  await assert.rejects(
    within(
      cancelAfterBody(
        Promise.resolve(),
        new Promise(() => {}),
        controller,
        host.signal,
      ),
      250,
    ),
    { name: 'AbortError' },
  );
});
void test('one deadline covers body observation and a request ignoring its abort', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const body = batchDeferred<void>();
  const settled: unknown[] = [];
  const request = cancelAfterBody(
    body.promise,
    new Promise(() => {}),
    controller,
    new AbortController().signal,
  ).then(
    () => settled.push('completed'),
    (error: unknown) => settled.push(error),
  );
  context.mock.timers.tick(HTTP_MULTI.operationMs - 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.signal.aborted, false);
  body.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(controller.signal.aborted);
  assert.equal(settled.length, 0);
  context.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, [new NativeTestDeadlineError()]);
  await request;
});
