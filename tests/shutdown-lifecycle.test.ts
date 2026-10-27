// Protects the actual entrypoint signal wiring and makes shutdown reporting an optional side effect.
// Every process runs with synthetic hosts and a disposable home; no seller engine or paid service starts.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHUTDOWN_PROBE_ENTRIES,
  shutdownProbe,
} from './support/shutdown-probe.js';

for (const entry of Object.values(SHUTDOWN_PROBE_ENTRIES)) {
  void test(
    `${entry} shutdown completes after repeated signals when stderr is closed`,
    { timeout: 30000 },
    async () => {
      const result = await shutdownProbe({ entry, closedStderr: true });
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      const report: unknown = JSON.parse(
        result.output.trim().split('\n').at(-1)!,
      );
      assert.deepEqual(report, {
        completed: true,
        rejected: false,
        listeners: [0, 0],
      });
    },
  );
}
void test(
  'shutdown completes if the optional notice throws',
  { timeout: 30000 },
  async () => {
    const result = await shutdownProbe({
      entry: SHUTDOWN_PROBE_ENTRIES.HELPER,
      throwingNotice: true,
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.output.trim().split('\n').at(-1)!), {
      completed: true,
      rejected: false,
      listeners: [0, 0],
    });
  },
);
for (const entry of [
  SHUTDOWN_PROBE_ENTRIES.SELLER,
  SHUTDOWN_PROBE_ENTRIES.BUYER,
]) {
  void test(
    `${entry} production entry keeps signal handlers throughout successful cleanup`,
    { timeout: 30000 },
    async () => {
      const result = await shutdownProbe({ entry });
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /Stopping/);
      assert.deepEqual(JSON.parse(result.output.trim().split('\n').at(-1)!), {
        completed: true,
        rejected: false,
        listeners: [0, 0],
      });
    },
  );
  void test(
    `${entry} production entry disposes handlers after rejected cleanup`,
    { timeout: 30000 },
    async () => {
      const result = await shutdownProbe({ entry, rejectStop: true });
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 1, result.stderr);
      assert.deepEqual(JSON.parse(result.output.trim().split('\n').at(-1)!), {
        completed: true,
        rejected: entry === SHUTDOWN_PROBE_ENTRIES.SELLER,
        listeners: [0, 0],
      });
    },
  );
}
