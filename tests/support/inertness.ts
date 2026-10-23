// Runs entrypoint imports with network and process effects trapped, then asserts none happened and no
// signal handler or exit code leaked; test-only, never imported by product code.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export async function assertImportsInert(run: () => Promise<void>) {
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
    await run();
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
}
