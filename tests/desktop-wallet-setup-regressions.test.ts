// Regression cases use disposable keys and paths, never an installed user wallet.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWalletService, WALLET } from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import { createWalletSetup } from '@gyblos/desktop/wallet-setup';
import {
  parseSetupRequest,
  SETUP_ACTION,
  SETUP_STATUS,
} from '@gyblos/desktop/wallet-setup-model';

import { absent, fixture } from './support/wallet-restore.js';

void test('first-run restoration accepts a valid multibyte portable-backup password', async () => {
  await fixture(async ({ home, root, identity, protection }) => {
    const password = 'é'.repeat(6);
    assert.notEqual(
      parseSetupRequest({
        action: SETUP_ACTION.RESTORE,
        password: String.fromCodePoint(0xfeff) + password,
      }),
      null,
    );
    const backup = await createBackupCodec().seal(identity.secret, password);
    assert.notEqual(
      parseSetupRequest({ action: SETUP_ACTION.RESTORE, password }),
      null,
    );
    const path = join(home, 'synthetic-multibyte-backup.json');
    await writeFile(path, backup);
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => path },
      new AbortController().signal,
    );
    const restored = await setup.run({
      action: SETUP_ACTION.RESTORE,
      password,
    });
    assert.equal(restored.status, SETUP_STATUS.RESTORED);
    assert.equal(restored.address, identity.address);
    await setup.run({ action: SETUP_ACTION.CONTINUE });
    assert.equal((await setup.summary).fundingEnabled, false);
  });
});
void test('a backup bound to first-run identity never initializes a replacement after record loss', async () => {
  await fixture(async ({ root, protection }) => {
    const setup = createWalletSetup(
      root,
      protection,
      { select: async () => null },
      new AbortController().signal,
    );
    const backupWallet = createWalletService(root, protection, setup.summary);
    await setup.run({ action: SETUP_ACTION.CREATE });
    const original = await setup.summary;
    await rm(join(root, WALLET.DIRECTORY), { recursive: true, force: true });
    await assert.rejects(backupWallet.withSecret(async () => true));
    assert.deepEqual(await backupWallet.summary(), original);
    await absent(join(root, WALLET.DIRECTORY));
  });
});
void test('an already-aborted first-run setup never opens the existing secure store', async () => {
  await fixture(async ({ root, protection }) => {
    await createWalletService(root, protection).summary();
    let checks = 0;
    let reads = 0;
    const counted = {
      ...protection,
      available: async () => {
        checks += 1;
        return true;
      },
      decrypt: async (bytes: Buffer) => {
        reads += 1;
        return protection.decrypt(bytes);
      },
    };
    const controller = new AbortController();
    controller.abort();
    const setup = createWalletSetup(
      root,
      counted,
      { select: async () => null },
      controller.signal,
    );
    await setup.summary;
    await setup.settled();
    assert.equal(checks, 0);
    assert.equal(reads, 0);
  });
});
void test('abort while checking store availability prevents a subsequent key read', async () => {
  await fixture(async ({ root, protection }) => {
    await createWalletService(root, protection).summary();
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release: (value: boolean) => void = () => {};
    const available = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const counted = {
      ...protection,
      available: () => {
        enter();
        return available;
      },
      decrypt: async (bytes: Buffer) => {
        reads += 1;
        return protection.decrypt(bytes);
      },
    };
    const controller = new AbortController();
    const setup = createWalletSetup(
      root,
      counted,
      { select: async () => null },
      controller.signal,
    );
    await entered;
    controller.abort();
    release(true);
    await setup.summary;
    await setup.settled();
    assert.equal(reads, 0);
  });
});
