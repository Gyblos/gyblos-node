// Internal Node-only restoration into an absent wallet destination; no UI, IPC or funding.
// Once a destination is claimed, failures preserve encrypted state and require inspection.
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BackupError, createBackupCodec } from './backup/index.js';
import { WALLET, WALLET_RESTORE_ERROR, WALLET_STATUS } from './constants.js';
import {
  ensureWalletRoot,
  isMissing,
  syncWalletDirectory,
  writeNewWallet,
} from './files.js';
import type { WalletSummary } from './model.js';
import type { WalletProtection } from './protection.js';
import { WalletRestoreError } from './restore-error.js';
import { readExistingWallet } from './service.js';

export { WALLET_RESTORE_ERROR } from './constants.js';
export { WalletRestoreError } from './restore-error.js';

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new WalletRestoreError(WALLET_RESTORE_ERROR.CANCELLED);
}
async function absentDestination(root: string) {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new WalletRestoreError(WALLET_RESTORE_ERROR.FAILED);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await lstat(join(root, WALLET.DIRECTORY));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new WalletRestoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS);
}
async function claim(root: string) {
  try {
    await mkdir(join(root, WALLET.DIRECTORY), {
      mode: WALLET.PRIVATE_DIRECTORY,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new WalletRestoreError(WALLET_RESTORE_ERROR.DESTINATION_EXISTS);
    throw error;
  }
}
export function createWalletRestorer(
  root: string,
  protection: WalletProtection | null,
) {
  const codec = createBackupCodec();
  let active = false;
  async function restore(
    file: Uint8Array,
    password: string,
    signal?: AbortSignal,
  ): Promise<WalletSummary> {
    let claimed = false;
    let ciphertext: Buffer | undefined;
    try {
      cancelled(signal);
      await absentDestination(root);
      if (!protection || !(await protection.available()))
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.UNAVAILABLE);
      const recovered = await codec.recover(file, password, signal);
      cancelled(signal);
      ciphertext = await protection.encrypt(recovered.secret);
      if ((await protection.decrypt(ciphertext)) !== recovered.secret)
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.FAILED);
      cancelled(signal);
      if (!(await protection.available()))
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.UNAVAILABLE);
      await absentDestination(root);
      await ensureWalletRoot(root);
      cancelled(signal);
      await claim(root);
      claimed = true;
      cancelled(signal);
      await syncWalletDirectory(root);
      cancelled(signal);
      await writeNewWallet(
        join(root, WALLET.DIRECTORY),
        JSON.stringify({
          format: WALLET.FORMAT,
          provider: protection.provider,
          ciphertext: ciphertext.toString('base64'),
        }),
      );
      cancelled(signal);
      const persisted = await readExistingWallet(root, protection);
      if (
        persisted.status !== WALLET_STATUS.READY ||
        persisted.address !== recovered.address
      )
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED);
      cancelled(signal);
      return persisted;
    } catch (error) {
      if (claimed)
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.RECOVERY_REQUIRED);
      if (signal?.aborted)
        throw new WalletRestoreError(WALLET_RESTORE_ERROR.CANCELLED);
      if (error instanceof WalletRestoreError || error instanceof BackupError)
        throw error;
      throw new WalletRestoreError(WALLET_RESTORE_ERROR.FAILED);
    } finally {
      ciphertext?.fill(0);
    }
  }
  return {
    async restore(file: Uint8Array, password: string, signal?: AbortSignal) {
      if (active) throw new WalletRestoreError(WALLET_RESTORE_ERROR.BUSY);
      active = true;
      try {
        return await restore(file, password, signal);
      } finally {
        active = false;
      }
    },
  };
}
