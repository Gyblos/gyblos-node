// Restores a sandbox journal even if its local inference engine is unavailable.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openPaypalSandbox } from '@gyblos/node/paypal-startup';

void test('desktop can open its sandbox state while the local model is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-paypal-offline-'));
  try {
    const sandbox = await openPaypalSandbox({
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      stateDirectory: directory,
      returnOrigin: 'http://127.0.0.1:12345',
      ollamaOrigin: 'http://127.0.0.1:1',
      deferEngineCheck: true,
    });
    try {
      assert.equal(await sandbox.journal.read(), null);
      await assert.rejects(sandbox.engine.describe());
    } finally {
      await sandbox.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
