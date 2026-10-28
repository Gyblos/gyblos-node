// A second Ctrl-C while the seller stops must not kill it mid-write (it left a stale public-sequence lock
// in the first real run). The first signal starts the stop; later ones only print a notice.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

void test(
  'repeated signals during shutdown are absorbed until the stop finishes',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-shutdown-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const marker = join(directory, 'stopped');
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/support/shutdown-child.ts', marker],
        { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const started = child;
      await new Promise<void>((resolve, reject) => {
        started.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('ready')) resolve();
        });
        started.once('exit', () =>
          reject(new Error('child exited before ready')),
        );
      });
      const exited = once(started, 'exit');
      started.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 100));
      started.kill('SIGINT');
      started.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(signal, null, 'the process was killed by a repeated signal');
      assert.equal(code, 0);
      assert.equal(await readFile(marker, 'utf8'), 'done');
      assert.match(stderr, /Stopping/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  },
);
