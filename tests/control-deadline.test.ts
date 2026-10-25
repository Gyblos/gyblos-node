// controlDeadline cancellation paths: every exit reports CONTROL_CANCELLED once, without unhandled rejections.
// Pure synthetic runners; no sockets, Iroh endpoints or existing state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import { controlDeadline } from '@gyblos/transport-iroh/control-io';

async function withoutUnhandled(body: () => Promise<void>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}
const cancelled = (error: unknown) =>
  error instanceof ControlError && error.code === CONTROL_CODES.CANCELLED;
const pending = () => new Promise<never>(() => {});

void test('controlDeadline: an already-aborted signal cancels before running and leaves no unhandled rejection', () =>
  withoutUnhandled(async () => {
    let runs = 0;
    let cancels = 0;
    await assert.rejects(
      controlDeadline(
        () => (runs++, pending()),
        1000,
        () => cancels++,
        AbortSignal.abort(),
      ),
      cancelled,
    );
    assert.equal(runs, 0);
    assert.equal(cancels, 1);
  }));

void test('controlDeadline: an abort while running cancels once and leaves no unhandled rejection', () =>
  withoutUnhandled(async () => {
    const external = new AbortController();
    let cancels = 0;
    const result = controlDeadline(
      () => pending(),
      1000,
      () => cancels++,
      external.signal,
    );
    external.abort();
    external.abort();
    await assert.rejects(result, cancelled);
    assert.equal(cancels, 1);
  }));

void test('controlDeadline: the deadline cancels a stalled runner and leaves no unhandled rejection', () =>
  withoutUnhandled(async () => {
    let cancels = 0;
    await assert.rejects(
      controlDeadline(
        () => pending(),
        5,
        () => cancels++,
      ),
      cancelled,
    );
    assert.equal(cancels, 1);
  }));

void test('controlDeadline: a completed runner returns its value without cancelling', () =>
  withoutUnhandled(async () => {
    let cancels = 0;
    const external = new AbortController();
    assert.equal(
      await controlDeadline(
        () => Promise.resolve('ok'),
        1000,
        () => cancels++,
        external.signal,
      ),
      'ok',
    );
    external.abort();
    assert.equal(cancels, 0);
  }));
