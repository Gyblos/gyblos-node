// Owns offline import-inertness regressions for product executable entrypoints and node lifecycle; lab
// entrypoints are checked in tests/lab. No funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_STATES } from '@gyblos/node/constants';
import { createNodeLifecycle } from '@gyblos/node/lifecycle';

import { assertImportsInert } from './support/inertness.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

void test('all executable modules are inert when imported', async (context) => {
  let starts = 0;
  let stops = 0;
  const node = createNodeLifecycle(async () => {
    starts++;
    return {
      async close() {
        stops++;
      },
    };
  });
  assert.equal(node.health().state, NODE_STATES.STOPPED);
  await Promise.all([node.start(), node.start()]);
  assert.equal(starts, 1);
  assert.equal(node.health().state, NODE_STATES.RUNNING);
  await node.stop();
  await node.stop();
  assert.equal(stops, 1);
  assert.equal(node.health().state, NODE_STATES.STOPPED);
  const failure = new Error('Synthetic startup refusal');
  const refused = createNodeLifecycle(async () => {
    throw failure;
  });
  await assert.rejects(refused.start(), (error) => error === failure);
  assert.equal(refused.health().state, NODE_STATES.STOPPED);
  let releaseStart = () => {};
  let releaseStop = () => {};
  let reportClosing = () => {};
  const closing = new Promise<void>((resolve) => {
    reportClosing = resolve;
  });
  let racingStarts = 0;
  let racingStops = 0;
  const racing = createNodeLifecycle(async () => {
    racingStarts++;
    if (racingStarts === 1)
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    return {
      async close() {
        racingStops++;
        if (racingStops === 1) {
          reportClosing();
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
        }
      },
    };
  });
  const firstStart = racing.start();
  const stopping = racing.stop();
  const restarting = racing.start();
  await Promise.resolve();
  releaseStart();
  await firstStart;
  await closing;
  const duringShutdown = racing.start();
  assert.equal(racingStarts, 1);
  releaseStop();
  await Promise.all([stopping, restarting, duringShutdown]);
  assert.equal(racingStarts, 2);
  assert.equal(racingStops, 1);
  assert.equal(racing.health().state, NODE_STATES.RUNNING);
  await racing.stop();
  assert.equal(racingStops, 2);
  assert.equal(racing.health().state, NODE_STATES.STOPPED);
  await assertImportsInert(async () => {
    await import('@gyblos/buyer/setup');
    await context.test(
      'native role setup entry is inert when imported',
      { skip: NATIVE_CAPABILITY.bindingSkip },
      async () => {
        await import('@gyblos/node-app/main');
        await import('@gyblos/node-app/setup');
        await import('@gyblos/buyer/main');
        await import('@gyblos/buyer/trust');
      },
    );
  });
});
