// Owns offline child-process readiness regressions for @gyblos/runtime; no funded wallets or live services.
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import test from 'node:test';

import { waitReady } from '@gyblos/runtime/process';

void test('shared readiness preserves ownership rejection and caller-specific error identity', async () => {
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

void test('shared readiness preserves early exit and setup error messages', async () => {
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

void test('setup readiness preserves HTTP-only acceptance without parsing a body', async () => {
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
