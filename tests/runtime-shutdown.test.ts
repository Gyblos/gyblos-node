// A second Ctrl-C while the seller stops must not kill it mid-write (it left a stale public-sequence lock
// in the first real run). The first signal starts the stop; later ones only print a notice.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures.js';

void test('repeated signals during shutdown are absorbed until the stop finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-shutdown-'));
  try {
    const marker = join(directory, 'stopped');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/support/shutdown-child.ts', marker],
      { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await new Promise<void>((resolve) =>
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve();
      }),
    );
    const exited = once(child, 'exit');
    child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill('SIGINT');
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(signal, null, 'the process was killed by a repeated signal');
    assert.equal(code, 0);
    assert.equal(await readFile(marker, 'utf8'), 'done');
    assert.match(stderr, /Stopping/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
