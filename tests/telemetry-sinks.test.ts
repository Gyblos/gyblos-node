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
import test from 'node:test';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import { createConsoleTelemetrySink } from '@gyblos/telemetry-console';
import { createFileTelemetrySink } from '@gyblos/telemetry-file';

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
    const directory = join(root, 'seller', 'telemetry');
    return {
      sink: createFileTelemetrySink({
        environment: { GYBLOS_HOME: root },
        role: 'seller',
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
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
  },
});
void test('file telemetry bounds the pending open buffer and records overflow', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-telemetry-buffer-')),
  );
  const sink = createFileTelemetrySink({
    environment: { GYBLOS_HOME: root },
    role: 'buyer',
  });
  try {
    for (let index = 0; index < PRIVATE_LOG_LIMITS.pendingRecords + 5; index++)
      sink.emit(telemetryEvents()[0]!);
    const health = await sink.close();
    assert.equal(health.emitted, PRIVATE_LOG_LIMITS.pendingRecords);
    assert.equal(health.dropped, 5);
    assert.equal(health.failed, false);
  } finally {
    await sink.close();
    await rm(root, { recursive: true, force: true });
  }
});
