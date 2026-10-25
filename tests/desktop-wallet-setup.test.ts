// Exercises first-run choice and recovery with disposable wallets; never OS/user keys.
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  WALLET,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import { createWalletSetup } from '@gyblos/desktop/wallet-setup';
import {
  parseSetupRequest,
  parseSetupView,
  SETUP_ACTION,
  SETUP_ERROR,
  SETUP_STATUS,
} from '@gyblos/desktop/wallet-setup-model';

import { TEST_BACKUP_PASSWORD } from './support/portable-backup-fixture.js';
import { absent, fixture } from './support/wallet-restore.js';

void test('first-run setup waits for explicit choice without generating a wallet', async () => {
  await fixture(async ({ root, protection }) => {
    const controller = new AbortController();
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => null },
      controller.signal,
    );
    let completed = false;
    void setup.summary.then(() => {
      completed = true;
    });
    assert.equal((await setup.state()).status, SETUP_STATUS.CHOICE);
    await Promise.resolve();
    assert.equal(completed, false);
    await absent(root);
    controller.abort();
    assert.equal((await setup.summary).fundingEnabled, false);
    await setup.settled();
    await absent(root);
  });
});
void test('explicit default creation preserves the protected wallet and funding block', async () => {
  await fixture(async ({ root, protection }) => {
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => null },
      new AbortController().signal,
    );
    await setup.run({ action: SETUP_ACTION.CREATE });
    const summary = await setup.summary;
    assert.equal(summary.status, WALLET_STATUS.READY);
    assert.equal(summary.fundingEnabled, false);
    assert.equal(summary.backupVerified, false);
    assert.deepEqual(
      await createWalletService(root, protection).summary(),
      summary,
    );
  });
});
void test('first-run restoration confirms the original address before opening the app', async () => {
  await fixture(async ({ home, root, backup, identity, protection }) => {
    const path = join(home, 'synthetic-backup.json');
    await writeFile(path, backup);
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => path },
      new AbortController().signal,
    );
    let completed = false;
    void setup.summary.then(() => {
      completed = true;
    });
    const restored = await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    assert.equal(restored.status, SETUP_STATUS.RESTORED);
    assert.equal(restored.address, identity.address);
    assert.equal(completed, false);
    await setup.run({ action: SETUP_ACTION.CREATE });
    assert.equal((await setup.state()).status, SETUP_STATUS.RESTORED);
    await setup.run({ action: SETUP_ACTION.CONTINUE });
    const summary = await setup.summary;
    assert.equal(summary.address, identity.address);
    assert.equal(summary.fundingEnabled, false);
    assert.equal(summary.backupVerified, false);
    assert.deepEqual(
      await createWalletService(root, protection).summary(),
      summary,
    );
  });
});
void test('existing wallets bypass choice and cannot be replaced from first-run IPC', async () => {
  await fixture(async ({ root, protection }) => {
    const original = await createWalletService(root, protection).summary();
    const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
    const before = await readFile(path);
    let selections = 0;
    const setup = createWalletSetup(
      root,
      protection,
      {
        select: async () => {
          selections += 1;
          return null;
        },
      },
      new AbortController().signal,
    );
    assert.equal((await setup.state()).status, SETUP_STATUS.COMPLETE);
    await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    assert.deepEqual(await setup.summary, original);
    assert.equal(selections, 0);
    assert.deepEqual(await readFile(path), before);
  });
});
void test('partial wallets are retained rather than offered replacement', async () => {
  await fixture(async ({ root, protection }) => {
    await mkdir(root, { mode: WALLET.PRIVATE_DIRECTORY });
    await mkdir(join(root, WALLET.DIRECTORY), {
      mode: WALLET.PRIVATE_DIRECTORY,
    });
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => null },
      new AbortController().signal,
    );
    assert.equal((await setup.summary).status, WALLET_STATUS.RECOVERY_REQUIRED);
    assert.equal((await setup.state()).status, SETUP_STATUS.COMPLETE);
    assert.equal(
      (await lstat(join(root, WALLET.DIRECTORY))).isDirectory(),
      true,
    );
  });
});
void test('bad password and cancelled file selection never fall back to creating a wallet', async () => {
  await fixture(async ({ home, root, backup, protection }) => {
    const path = join(home, 'synthetic-backup.json');
    await writeFile(path, backup);
    let selected: string | null = path;
    const controller = new AbortController();
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => selected },
      controller.signal,
    );
    const failed = await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: 'Wrong password for testing',
    });
    assert.equal(failed.error, SETUP_ERROR.FAILED);
    await absent(root);
    selected = null;
    assert.equal(
      (
        await setup.run({
          action: SETUP_ACTION.RESTORE,
          password: TEST_BACKUP_PASSWORD,
        })
      ).error,
      null,
    );
    await absent(root);
    controller.abort();
    await setup.summary;
    await setup.settled();
  });
});
void test('first-run request and response parsing refuse extra paths, secrets and invalid passwords', () => {
  assert.equal(
    parseSetupRequest({ action: SETUP_ACTION.CREATE, path: '/invalid' }),
    null,
  );
  assert.equal(
    parseSetupRequest({ action: SETUP_ACTION.RESTORE, password: 'short' }),
    null,
  );
  assert.equal(
    parseSetupRequest({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
      path: '/invalid',
    }),
    null,
  );
  assert.equal(
    parseSetupView({
      status: SETUP_STATUS.RESTORED,
      address: 'invalid',
      error: null,
    }).status,
    SETUP_STATUS.BLOCKED,
  );
  assert.equal(
    parseSetupView({
      status: SETUP_STATUS.CHOICE,
      address: null,
      error: null,
      secret: 'invalid',
    }).status,
    SETUP_STATUS.BLOCKED,
  );
});
