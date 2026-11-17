// The acceptance registry fence must retain caller cancellation and POST bodies through garbage collection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

void test('receipt acceptance registry forwarding preserves abort after request collection', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(
        new URL('../support/receipt-fetch-abort-gc.ts', import.meta.url),
      ),
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});
