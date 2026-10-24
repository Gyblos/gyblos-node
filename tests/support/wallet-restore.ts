// Disposable restoration fixtures and assertions; never access product homes or keys.
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import {
  WALLET_RESTORE_ERROR,
  WalletRestoreError,
} from '@gyblos/desktop/wallet-restore';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './portable-backup-fixture.js';

export async function fixture(
  run: (value: {
    home: string;
    root: string;
    backup: Buffer;
    identity: ReturnType<typeof disposableIdentity>;
    protection: ReturnType<typeof disposableProtection>;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-restore-'));
  try {
    const identity = disposableIdentity();
    const backup = await createBackupCodec().seal(
      identity.secret,
      TEST_BACKUP_PASSWORD,
    );
    await run({
      home,
      root: join(home, 'destination'),
      backup,
      identity,
      protection: disposableProtection(),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export function restoreError(
  code: (typeof WALLET_RESTORE_ERROR)[keyof typeof WALLET_RESTORE_ERROR],
) {
  return (error: unknown) =>
    error instanceof WalletRestoreError && error.code === code;
}
export async function absent(path: string) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}
