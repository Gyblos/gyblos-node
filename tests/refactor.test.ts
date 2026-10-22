import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { NODE_STATES } from '@gyblos/node/constants';
import { createNodeLifecycle } from '@gyblos/node/lifecycle';

import { waitReady } from '../packages/runtime/src/process.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

test('all executable modules are inert when imported', async (context) => {
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
  const originalFetch = globalThis.fetch,
    originalSpawn = childProcess.spawn,
    exitCode = process.exitCode;
  let fetches = 0,
    spawns = 0;
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
      'lab/harness/src/cli/buyer.ts',
      'lab/harness/src/cli/exact.ts',
      'lab/harness/src/cli/inference.ts',
      'lab/harness/src/cli/run.ts',
      'lab/harness/src/cli/preflight.ts',
      'apps/node/src/fixed.ts',
      'apps/facilitator/src/main.ts',
      'lab/harness/scripts/challenge.ts',
      'lab/harness/scripts/fund.ts',
      'lab/harness/scripts/failures.ts',
      'lab/harness/scripts/inference-setup.ts',
    ])
      await import('../' + file);
    await context.test(
      'native role setup entry is inert when imported',
      { skip: NATIVE_CAPABILITY.bindingSkip },
      async () => {
        await import('../apps/node/src/main.js');
        await import('../apps/buyer/src/main.js');
        await import('../lab/harness/scripts/setup.js');
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

test('shared readiness preserves ownership rejection and caller-specific error identity', async () => {
  const original = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return Response.json({ runId: 'another-process' });
  }) as typeof fetch;
  const child = { exitCode: null, signalCode: null } as ChildProcess;
  const mismatch = new Error(
    'Gate port belongs to a different process. No payment attempted.',
  );
  try {
    await assert.rejects(
      waitReady(child, 'http://fake', {
        expectedRunId: 'current',
        onMismatch: () => mismatch,
      }),
      (error) => error === mismatch,
    );
    assert.equal(reads, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('shared readiness preserves early exit and setup error messages', async () => {
  await assert.rejects(
    waitReady(
      { exitCode: 1, signalCode: null } as ChildProcess,
      'http://fake',
      { exitMessage: 'Local Ollama startup failed.' },
    ),
    /Local Ollama startup failed/,
  );
  await assert.rejects(
    waitReady(
      { exitCode: null, signalCode: null } as ChildProcess,
      'http://fake',
      { startupError: () => true, exitMessage: 'Local Ollama startup failed.' },
    ),
    /Local Ollama startup failed/,
  );
});

test('setup readiness preserves HTTP-only acceptance without parsing a body', async () => {
  const original = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return new Response('not JSON', { status: 200 });
  }) as typeof fetch;
  try {
    await waitReady(
      { exitCode: null, signalCode: null } as ChildProcess,
      'http://fake',
      { parseBody: false, attempts: 1 },
    );
    assert.equal(reads, 1);
  } finally {
    globalThis.fetch = original;
  }
});
