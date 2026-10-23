// Owns offline import-inertness regressions for executable entrypoints and node lifecycle; no funded wallets or live services.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { NODE_STATES } from '@gyblos/node/constants';
import { createNodeLifecycle } from '@gyblos/node/lifecycle';

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
  const beforeSignals = ['SIGINT', 'SIGTERM'].map((s) =>
    process.listenerCount(s),
  );
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  const exitCode = process.exitCode;
  let fetches = 0;
  let spawns = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error('Unexpected network effect');
  }) as typeof fetch;
  childProcess.spawn = (() => {
    spawns++;
    throw new Error('Unexpected process effect');
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    for (const file of [
      '@gyblos/lab-harness/cli/buyer',
      '@gyblos/lab-harness/cli/exact',
      '@gyblos/lab-harness/cli/inference',
      '@gyblos/lab-harness/cli/run',
      '@gyblos/lab-harness/cli/preflight',
      '@gyblos/node-app/fixed',
      '@gyblos/facilitator/main',
      '@gyblos/lab-harness/commands/challenge',
      '@gyblos/lab-harness/commands/fund',
      '@gyblos/lab-harness/commands/failures',
      '@gyblos/lab-harness/commands/inference-setup',
    ])
      await import(file);
    await context.test(
      'native role setup entry is inert when imported',
      { skip: NATIVE_CAPABILITY.bindingSkip },
      async () => {
        await import('@gyblos/node-app/main');
        await import('@gyblos/buyer/main');
        await import('@gyblos/lab-harness/commands/setup');
      },
    );
    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
    assert.equal(process.exitCode, exitCode);
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s)),
      beforeSignals,
    );
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
    process.exitCode = exitCode;
    syncBuiltinESMExports();
  }
});
