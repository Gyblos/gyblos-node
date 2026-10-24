// Exercises restoration against a disposable descriptor replacement race, never a real wallet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createWalletService,
  WALLET,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import {
  createWalletRestorer,
  WALLET_RESTORE_ERROR,
} from '@gyblos/desktop/wallet-restore';

import { TEST_BACKUP_PASSWORD } from './support/portable-backup-fixture.js';
import { fixture, restoreError } from './support/wallet-restore.js';

void test(
  'wallet restore reload refuses a file replaced by FIFO without blocking recovery',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async ({ root, backup, protection }) => {
      const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
      const original = fs.promises.lstat;
      let rescued = false;
      let rescue: ReturnType<typeof setTimeout> | undefined;
      const patched = async (...args: Parameters<typeof original>) => {
        const metadata = await original(...args);
        if (args[0] === path) {
          await fs.promises.unlink(path);
          execFileSync('mkfifo', [path]);
          rescue = setTimeout(() => {
            rescued = true;
            const writer = fs.openSync(
              path,
              constants.O_WRONLY | constants.O_NONBLOCK,
            );
            fs.closeSync(writer);
          }, 500);
        }
        return metadata;
      };
      // External overloaded Node double: this call never requests bigint stats.
      fs.promises.lstat = patched as typeof original;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          createWalletRestorer(root, protection).restore(
            backup,
            TEST_BACKUP_PASSWORD,
          ),
          restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
        );
        assert.equal(rescued, false, 'reload needed FIFO writer rescue');
      } finally {
        clearTimeout(rescue);
        fs.promises.lstat = original;
        syncBuiltinESMExports();
      }
    });
  },
);

void test('wallet restore retains interrupted encrypted staging and prevents automatic replacement', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    const original = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (args[0] === join(root, WALLET.DIRECTORY, WALLET.STAGING))
        handle.sync = async () => {
          throw new Error('synthetic private disk failure');
        };
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
        ),
        restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
      );
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
    const pending = await readFile(
      join(root, WALLET.DIRECTORY, WALLET.STAGING),
      'utf8',
    );
    assert.equal(pending.includes(identity.secret), false);
    assert.equal(
      (await createWalletService(root, protection).summary()).status,
      WALLET_STATUS.RECOVERY_REQUIRED,
    );
    await assert.rejects(
      createWalletRestorer(root, protection).restore(
        backup,
        TEST_BACKUP_PASSWORD,
      ),
      restoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS),
    );
    assert.equal(
      await readFile(join(root, WALLET.DIRECTORY, WALLET.STAGING), 'utf8'),
      pending,
    );
  });
});
void test('wallet restore reports interrupted confirmation after cancellation during commit without generating another identity', async () => {
  await fixture(async ({ root, backup, protection, identity }) => {
    const original = fs.promises.open;
    const controller = new AbortController();
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (args[0] === join(root, WALLET.DIRECTORY, WALLET.STAGING)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          controller.abort();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
          controller.signal,
        ),
        restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
      );
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
    const restarted = await createWalletService(root, protection).summary();
    assert.equal(restarted.address, identity.address);
    assert.equal(restarted.fundingEnabled, false);
    assert.equal(restarted.backupVerified, false);
  });
});

void test('wallet restore reload rejects a protected record growing after descriptor validation', async () => {
  await fixture(async ({ root, backup, protection }) => {
    const path = join(root, WALLET.DIRECTORY, WALLET.RECORD);
    const original = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (args[0] === path) {
        const stat = handle.stat.bind(handle);
        // External FileHandle overload double; the reader requests ordinary stats.
        handle.stat = (async () => {
          const metadata = await stat();
          await fs.promises.appendFile(
            path,
            ' '.repeat(WALLET.MAX_RECORD_BYTES),
          );
          return metadata;
        }) as typeof handle.stat;
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWalletRestorer(root, protection).restore(
          backup,
          TEST_BACKUP_PASSWORD,
        ),
        restoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED),
      );
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
    assert.ok((await fs.promises.lstat(path)).size > WALLET.MAX_RECORD_BYTES);
    assert.equal(
      (await createWalletService(root, protection).summary()).status,
      WALLET_STATUS.RECOVERY_REQUIRED,
    );
  });
});
