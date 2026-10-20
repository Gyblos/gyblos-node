import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { waitReady } from '../packages/runtime/src/process.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

test('all executable modules are inert when imported', async (context) => {
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
      'apps/cli/src/buyer.ts',
      'apps/cli/src/exact.ts',
      'apps/cli/src/inference.ts',
      'apps/cli/src/run.ts',
      'apps/cli/src/preflight.ts',
      'apps/seller/src/main.ts',
      'apps/facilitator/src/main.ts',
      'scripts/challenge.ts',
      'scripts/fund.ts',
      'scripts/failures.ts',
      'scripts/inference-setup.ts',
    ])
      await import('../' + file);
    await context.test(
      'native role setup entry is inert when imported',
      { skip: NATIVE_CAPABILITY.bindingSkip },
      async () => {
        await import('../scripts/setup.js');
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
