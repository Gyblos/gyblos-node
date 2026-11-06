// Runs the common port contract against both plugins with isolated temporary product homes.
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { createConsoleTelemetrySink } from '@gyblos/telemetry-console';
import { createFileTelemetrySink } from '@gyblos/telemetry-file';

import { withLogIo } from './support/private-log-fixture';
import { setTimeout as delay } from 'node:timers/promises';
import { telemetryEvents } from './support/receipt-fixture';
import { telemetrySinkContract } from './support/telemetry-sink-contract';

telemetrySinkContract('console telemetry', {
  async start(broken) {
    let output = '';
    return {
      sink: createConsoleTelemetrySink({
        write(line) {
          if (broken) throw new Error('synthetic');
          output += line;
        },
      }),
      async output() {
        return output;
      },
      async assertInert() {
        assert.equal(output, '');
      },
      async cleanup() {},
    };
  },
});
telemetrySinkContract('file telemetry', {
  async start(broken) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'gyblos-telemetry-')),
    );
    if (broken) await writeFile(join(root, 'seller'), 'synthetic obstruction');
    const before = await readdir(root);
    const directory = join(root, 'seller', 'telemetry');
    return {
      sink: createFileTelemetrySink({
        environment: { GYBLOS_HOME: root },
        role: P2P_ROLES.SELLER,
      }),
      async output() {
        try {
          return (
            await Promise.all(
              (await readdir(directory)).sort().map(async (name) => {
                assert.equal(
                  (await stat(join(directory, name))).mode & 0o777,
                  0o600,
                );
                return readFile(join(directory, name), 'utf8');
              }),
            )
          ).join('');
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          )
            return '';
          throw error;
        }
      },
      async assertInert() {
        assert.deepEqual(await readdir(root), before);
      },
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
  },
});
async function withBufferSink(
  context: TestContext,
  run: (sink: TelemetrySink) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gyblos-telemetry-buffer-')));
  const sink = createFileTelemetrySink({ environment: { GYBLOS_HOME: root }, role: P2P_ROLES.BUYER });
  // The capacity test must not make real disk throughput a drain-deadline assertion.
  void context;
  try { await run(sink); }
  finally { await sink.flush(); await sink.close(); await rm(root, { recursive: true, force: true }); }
}
function fillBuffer(sink: TelemetrySink) {
  for (let index = 0; index < PRIVATE_LOG_LIMITS.pendingRecords + 5; index++) sink.emit(telemetryEvents()[0]!);
}
function assertBuffer(health: Awaited<ReturnType<TelemetrySink['close']>>) {
  assert.equal(health.emitted, PRIVATE_LOG_LIMITS.pendingRecords);
  assert.equal(health.dropped, 5);
  assert.equal(health.failed, false);
}
void test('file telemetry bounds the pending open buffer and records overflow', async (context) => {
  await withBufferSink(context, async (sink) => { fillBuffer(sink); assertBuffer(await sink.close()); });
});
void test('buffer capacity remains independent of a disk drain slower than the production deadline', { timeout: 15000 }, async (context) => {
  // Capture the real delay before the buffer fixture controls its drain clock.
  const realDelay = delay;
  await withLogIo(async (io) => {
    let reached = () => {};
    let release = () => {};
    const stalled = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    io.sync = async () => { if (io.fileSyncs === 2) { reached(); await released; } };
    await withBufferSink(context, async (sink) => {
      fillBuffer(sink);
      const closing = sink.close();
      try {
        await stalled;
        await realDelay(PRIVATE_LOG_LIMITS.drainMs + 25);
      } finally { release(); }
      assertBuffer(await closing);
      await sink.flush();
      assert.equal(io.fileSyncs, PRIVATE_LOG_LIMITS.pendingRecords + 1);
    });
  });
});
