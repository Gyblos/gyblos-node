// Exercises restoration against a disposable descriptor replacement race, never a real wallet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import { WALLET } from '@gyblos/desktop/wallet';
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
      const patched = async (...args: Parameters<typeof original>) => {
        const metadata = await original(...args);
        if (args[0] === path) {
          await fs.promises.unlink(path);
          execFileSync('mkfifo', [path]);
        }
        return metadata;
      };
      // External overloaded Node double: this call never requests bigint stats.
      fs.promises.lstat = patched as typeof original;
      syncBuiltinESMExports();
      let rescued = false;
      const rescue = setTimeout(() => {
        rescued = true;
        const writer = fs.openSync(
          path,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        fs.closeSync(writer);
      }, 1500);
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
