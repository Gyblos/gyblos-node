// Exercises user-approved backup orchestration with disposable wallets and dialogs.
// No real keystore, user wallet, payments or external services are accessed.
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  createBackupFlow,
  createWalletService,
  parseBackupRequest,
  parseBackupResult,
} from '@gyblos/desktop/wallet';

import {
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture.js';

async function fixture(
  run: (context: {
    home: string;
    file: string;
    wallet: ReturnType<typeof createWalletService>;
    controller: AbortController;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-backup-flow-'));
  try {
    const wallet = createWalletService(
      join(home, 'identity'),
      disposableProtection(),
    );
    await wallet.summary();
    await run({
      home,
      file: join(home, 'backup.json'),
      wallet,
      controller: new AbortController(),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
void test('backup flow saves encrypted file and verifies same address without enabling funding', async () => {
  await fixture(async ({ file, wallet, controller }) => {
    const before = await wallet.summary();
    const flow = createBackupFlow(
      wallet,
      {
        approve: async () => true,
        save: async () => file,
        select: async () => file,
      },
      controller.signal,
    );
    assert.equal(
      await flow.run({
        action: BACKUP_ACTION.CREATE,
        password: TEST_BACKUP_PASSWORD,
      }),
      BACKUP_RESULT.SAVED,
    );
    assert.equal(
      await flow.run({
        action: BACKUP_ACTION.VERIFY,
        password: TEST_BACKUP_PASSWORD,
      }),
      BACKUP_RESULT.VERIFIED,
    );
    assert.deepEqual(await wallet.summary(), before);
    assert.equal(before.backupVerified, false);
    assert.equal(before.fundingEnabled, false);
    const bytes = await readFile(file, 'utf8');
    assert.equal(bytes.includes('PRIVATE KEY'), false);
    if (process.platform !== 'win32')
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
  });
});
void test('backup flow cancels approval and file selection without creating a file', async () => {
  await fixture(async ({ file, wallet, controller }) => {
    let prompts = 0;
    const denied = createBackupFlow(
      wallet,
      {
        approve: async () => false,
        save: async () => {
          prompts++;
          return file;
        },
        select: async () => file,
      },
      controller.signal,
    );
    assert.equal(
      await denied.run({
        action: BACKUP_ACTION.CREATE,
        password: TEST_BACKUP_PASSWORD,
      }),
      BACKUP_RESULT.CANCELLED,
    );
    assert.equal(prompts, 0);
    const cancelled = createBackupFlow(
      wallet,
      {
        approve: async () => true,
        save: async () => null,
        select: async () => null,
      },
      controller.signal,
    );
    assert.equal(
      await cancelled.run({
        action: BACKUP_ACTION.CREATE,
        password: TEST_BACKUP_PASSWORD,
      }),
      BACKUP_RESULT.CANCELLED,
    );
    await assert.rejects(lstat(file), { code: 'ENOENT' });
  });
});
void test('backup flow refuses overwrite, bad password, altered files and another identity', async () => {
  await fixture(async ({ home, file, wallet, controller }) => {
    const dialogs = {
      approve: async () => true,
      save: async () => file,
      select: async () => file,
    };
    const flow = createBackupFlow(wallet, dialogs, controller.signal);
    const create = {
      action: BACKUP_ACTION.CREATE,
      password: TEST_BACKUP_PASSWORD,
    };
    const verify = {
      action: BACKUP_ACTION.VERIFY,
      password: TEST_BACKUP_PASSWORD,
    };
    assert.equal(await flow.run(create), BACKUP_RESULT.SAVED);
    const original = await readFile(file);
    assert.equal(await flow.run(create), BACKUP_RESULT.FAILED);
    assert.deepEqual(await readFile(file), original);
    assert.equal(
      await flow.run({ ...verify, password: 'wrong password for fixture' }),
      BACKUP_RESULT.FAILED,
    );
    const other = createWalletService(
      join(home, 'other'),
      disposableProtection(),
    );
    assert.equal(
      await createBackupFlow(other, dialogs, controller.signal).run(verify),
      BACKUP_RESULT.FAILED,
    );
    await writeFile(file, 'invalid backup');
    assert.equal(await flow.run(verify), BACKUP_RESULT.FAILED);
    assert.equal((await wallet.summary()).fundingEnabled, false);
  });
});
void test('backup flow serializes operations and suppresses creation after shutdown cancellation', async () => {
  await fixture(async ({ file, wallet, controller }) => {
    let approve: (value: boolean) => void = () => {};
    const waiting = new Promise<boolean>((resolve) => {
      approve = resolve;
    });
    const flow = createBackupFlow(
      wallet,
      {
        approve: () => waiting,
        save: async () => file,
        select: async () => file,
      },
      controller.signal,
    );
    const request = {
      action: BACKUP_ACTION.CREATE,
      password: TEST_BACKUP_PASSWORD,
    };
    const pending = flow.run(request);
    assert.equal(await flow.run(request), BACKUP_RESULT.BUSY);
    controller.abort();
    approve(true);
    assert.equal(await pending, BACKUP_RESULT.CANCELLED);
    await flow.settled();
    await assert.rejects(lstat(file), { code: 'ENOENT' });
  });
});
void test('backup IPC contract rejects malformed requests and sanitizes response objects', () => {
  assert.equal(
    parseBackupRequest({ action: BACKUP_ACTION.CREATE, password: 'short' }),
    null,
  );
  assert.equal(
    parseBackupRequest({ action: 'export', password: TEST_BACKUP_PASSWORD }),
    null,
  );
  assert.equal(
    parseBackupRequest({
      action: BACKUP_ACTION.CREATE,
      password: TEST_BACKUP_PASSWORD,
      path: '/private',
    }),
    null,
  );
  assert.equal(
    parseBackupRequest({
      action: BACKUP_ACTION.CREATE,
      password: 'é'.repeat(1024),
    }),
    null,
  );
  assert.equal(
    parseBackupResult({
      status: BACKUP_RESULT.SAVED,
      secret: 'must not escape',
    }),
    BACKUP_RESULT.FAILED,
  );
  assert.equal(
    parseBackupResult(BACKUP_RESULT.VERIFIED),
    BACKUP_RESULT.VERIFIED,
  );
});
