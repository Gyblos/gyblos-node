// First-run cancellation and races retain durable state; no real wallets or OS stores.
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  WALLET,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import { createWalletSetup } from '@gyblos/desktop/wallet-setup';
import {
  SETUP_ACTION,
  SETUP_ERROR,
  SETUP_STATUS,
} from '@gyblos/desktop/wallet-setup-model';

import { TEST_BACKUP_PASSWORD } from './support/portable-backup-fixture.js';
import { absent, fixture } from './support/wallet-restore.js';

function deferred<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
void test('quit during native selection waits for settlement and never creates a replacement', async () => {
  await fixture(async ({ root, protection }) => {
    const entered = deferred<void>();
    const selected = deferred<string | null>();
    const controller = new AbortController();
    const setup = createWalletSetup(
      root,
      protection,
      {
        select: () => {
          entered.release();
          return selected.promise;
        },
      },
      controller.signal,
    );
    const operation = setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    await entered.promise;
    assert.equal(
      (await setup.run({ action: SETUP_ACTION.CREATE })).error,
      SETUP_ERROR.BUSY,
    );
    controller.abort();
    assert.equal((await setup.summary).status, WALLET_STATUS.UNAVAILABLE);
    let settled = false;
    const stopping = setup.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    selected.release(null);
    await operation;
    await stopping;
    await absent(root);
    assert.equal((await setup.state()).status, SETUP_STATUS.COMPLETE);
  });
});
void test('quit during explicit creation waits for the original protected record to finish', async () => {
  await fixture(async ({ root, protection }) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const slow = {
      ...protection,
      encrypt: async (secret: string) => {
        entered.release();
        await release.promise;
        return protection.encrypt(secret);
      },
    };
    const setup = createWalletSetup(
      root,
      slow,
      { select: async () => null },
      controller.signal,
    );
    const operation = setup.run({ action: SETUP_ACTION.CREATE });
    await entered.promise;
    controller.abort();
    await setup.summary;
    let settled = false;
    const stopping = setup.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release.release();
    await operation;
    await stopping;
    const persisted = await createWalletService(root, protection).summary();
    assert.equal(persisted.status, WALLET_STATUS.READY);
    assert.equal(persisted.fundingEnabled, false);
    assert.equal(persisted.backupVerified, false);
    assert.equal((await setup.state()).status, SETUP_STATUS.COMPLETE);
  });
});
void test('a failed post-claim restore blocks creation and retains the encrypted record', async () => {
  await fixture(async ({ home, root, backup, protection }) => {
    const path = join(home, 'synthetic-backup.json');
    await writeFile(path, backup);
    let decryptions = 0;
    const brokenReload = {
      ...protection,
      decrypt: async (bytes: Buffer) => {
        decryptions += 1;
        if (decryptions > 1) throw new Error('synthetic private failure');
        return protection.decrypt(bytes);
      },
    };
    const setup = createWalletSetup(
      root,
      brokenReload,
      { select: async () => path },
      new AbortController().signal,
    );
    const failed = await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    assert.equal(failed.status, SETUP_STATUS.BLOCKED);
    assert.equal(failed.error, SETUP_ERROR.RECOVERY_REQUIRED);
    const record = join(root, WALLET.DIRECTORY, WALLET.RECORD);
    const retained = await readFile(record);
    await setup.run({ action: SETUP_ACTION.CREATE });
    assert.deepEqual(await readFile(record), retained);
    await setup.run({ action: SETUP_ACTION.CONTINUE });
    const summary = await setup.summary;
    assert.equal(summary.status, WALLET_STATUS.RECOVERY_REQUIRED);
    assert.equal(summary.fundingEnabled, false);
  });
});
void test('a wallet appearing while selecting a backup wins without being overwritten', async () => {
  await fixture(async ({ home, root, backup, protection }) => {
    const path = join(home, 'synthetic-backup.json');
    await writeFile(path, backup);
    let original: Buffer | undefined;
    const setup = createWalletSetup(
      root,
      protection,
      {
        select: async () => {
          await createWalletService(root, protection).summary();
          original = await readFile(
            join(root, WALLET.DIRECTORY, WALLET.RECORD),
          );
          return path;
        },
      },
      new AbortController().signal,
    );
    assert.equal((await setup.state()).status, SETUP_STATUS.CHOICE);
    const failed = await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    assert.equal(failed.error, SETUP_ERROR.EXISTING);
    assert.equal(failed.status, SETUP_STATUS.BLOCKED);
    await setup.run({ action: SETUP_ACTION.CREATE });
    assert.deepEqual(
      await readFile(join(root, WALLET.DIRECTORY, WALLET.RECORD)),
      original,
    );
    await setup.run({ action: SETUP_ACTION.CONTINUE });
    assert.equal((await setup.summary).fundingEnabled, false);
  });
});
void test('invalid existing roots fail closed without restoring or generating keys', async () => {
  await fixture(async ({ root, protection }) => {
    await writeFile(root, 'synthetic existing root');
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
    await setup.run({
      action: SETUP_ACTION.RESTORE,
      password: TEST_BACKUP_PASSWORD,
    });
    assert.equal((await setup.summary).status, WALLET_STATUS.RECOVERY_REQUIRED);
    assert.equal(selections, 0);
    assert.equal((await lstat(root)).isFile(), true);
    assert.equal(await readFile(root, 'utf8'), 'synthetic existing root');
  });
});
