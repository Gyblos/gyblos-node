// Owns offline lock fixture regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { currentLockOwner } from '@gyblos/payments-x402/recovery/lock-owner';

export async function lockFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-public-lock-'));
  const paths = {
    buyer: join(directory, 'buyer.lock'),
    recovery: join(directory, 'recovery.lock'),
    audit: join(directory, 'audit.jsonl'),
  };
  const processResult = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(processResult.status, 0);
  assert.ok(processResult.pid);
  assert.throws(() => process.kill(processResult.pid, 0), { code: 'ESRCH' });
  const owner = await currentLockOwner();
  assert.ok(owner);
  const metadata = {
    pid: processResult.pid,
    startedAt: new Date().toISOString(),
    owner,
  };
  await writeFile(paths.buyer, JSON.stringify(metadata), {
    mode: FILE_MODES.privateFile,
  });
  return {
    directory,
    paths,
    metadata,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

export function interceptOpen(
  context: TestContext,
  afterOpen: (path: string, handle: FileHandle) => Promise<void>,
) {
  const original = fs.open;
  context.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      await afterOpen(String(args[0]), handle);
      return handle;
    },
  );
  syncBuiltinESMExports();
}

export function interceptAuditSync(
  context: TestContext,
  auditPath: string,
  afterSync: () => Promise<void>,
) {
  interceptOpen(context, async (path, handle) => {
    if (path !== auditPath) return;
    const original = handle.sync.bind(handle);
    context.mock.method(handle, 'sync', async () => {
      await original();
      await afterSync();
    });
  });
}

export function restoreFileMocks(context: TestContext) {
  context.mock.restoreAll();
  syncBuiltinESMExports();
}
