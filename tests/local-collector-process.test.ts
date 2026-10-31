// The explicit collector CLI is exercised only in a fresh private directory with a synthetic capability.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openRetainedReceiptStore } from '@gyblos/telemetry-file/retained-receipts';

import { managedReceiptFixture } from './support/local-collector';

void test('local collector CLI starts from private config and shuts down without leaking credentials or ownership', async (context) => {
  const f = await managedReceiptFixture(context);
  const config = join(f.directory, 'config.json');
  const token = 'cd'.repeat(32);
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      path: f.path,
      create: true,
      retentionMs: 100,
      port: 0,
      principals: [
        {
          buyerNodeId: f.entry.receipt.seller.record.buyerNodeId,
          token,
          consent: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(import.meta.resolve('@gyblos/receipt-collector/main')),
    ],
    {
      cwd: f.directory,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
        GYBLOS_COLLECTOR_CONFIG: config,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stopped = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  f.manage({
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await stopped;
    },
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (part: Buffer) => {
    errors += part.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('Collector exited before startup')),
      );
      child.stdout.on('data', (part: Buffer) => {
        output += part.toString();
        if (output.length > 512) {
          reject(new Error('Unexpected startup output'));
          child.kill('SIGKILL');
        } else if (output.includes('\n')) resolve();
      });
    });
    assert.deepEqual(JSON.parse(output), { ok: true, loopback: true });
    child.kill('SIGTERM');
    assert.equal(await stopped, 0);
    assert.equal(errors, '');
    assert.equal(output.includes(token), false);
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    assert.equal((await readFile(f.path, 'utf8')).includes(token), false);
    const store = f.manage(
      await openRetainedReceiptStore({
        path: f.path,
        retentionMs: 100,
        now: Date.now,
      }),
    );
    await store.close();
  } finally {
    clearTimeout(timer);
  }
});
