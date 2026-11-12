// Owns the generation window's edges that tests/execution-contract.test.ts does not reach through the
// lifecycle: stop runs at most once and only while the engine runs, every window gets its own timeout
// error, and a synchronous throw without a deadline rejects instead of escaping.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generationWindow } from '@gyblos/inference/generation-window';

class Timeout extends Error {}
const ERRORS = {
  timeout: () => new Timeout('timeout'),
  cancelled: () => new Error('cancelled'),
};
const live = () => new AbortController().signal;

void test('generation window: a deadline already passed never stops an engine that did not start', async () => {
  let stops = 0;
  const window = generationWindow(1_000, () => 1_000, live(), ERRORS);
  await assert.rejects(
    window.run(
      () => Promise.resolve('late'),
      () => stops++,
    ),
    Timeout,
  );
  assert.equal(stops, 0);
});

void test('generation window: stop runs once at the deadline, never for late checks or after the run', async () => {
  let clock = 1_000;
  let stops = 0;
  const window = generationWindow(1_020, () => clock, live(), ERRORS);
  const run = window.run(
    () => {
      clock = 1_030;
      // A late delta checks the deadline while the engine still runs.
      assert.throws(() => window.check(), Timeout);
      assert.throws(() => window.check(), Timeout);
      return Promise.resolve('done');
    },
    () => stops++,
  );
  await assert.rejects(run, Timeout);
  assert.equal(stops, 1);

  let after = 0;
  clock = 1_000;
  const finished = generationWindow(1_020, () => clock, live(), ERRORS);
  assert.equal(
    await finished.run(
      () => Promise.resolve('done'),
      () => after++,
    ),
    'done',
  );
  clock = 1_030;
  assert.throws(() => finished.check(), Timeout);
  assert.equal(after, 0);
});

void test('generation window: each window has its own timeout error', async () => {
  const errors: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    const window = generationWindow(1_000, () => 1_000, live(), ERRORS);
    await window
      .run(
        () => Promise.resolve('late'),
        () => {},
      )
      .catch((error) => {
        errors.push(error);
      });
  }
  assert.ok(errors[0] instanceof Timeout && errors[1] instanceof Timeout);
  assert.notEqual(errors[0], errors[1]);
});

void test('generation window: without a deadline a synchronous throw rejects the run', async () => {
  const failure = new Error('sync');
  const window = generationWindow(undefined, Date.now, live(), ERRORS);
  await assert.rejects(
    window.run(
      () => {
        throw failure;
      },
      () => {},
    ),
    failure,
  );
});
