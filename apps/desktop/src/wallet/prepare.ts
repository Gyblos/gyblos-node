// Automatic startup owns initialization only for an absent or empty dedicated root.
// Any retained state is read without creating a replacement identity.
import { readdir } from 'node:fs/promises';

import { WALLET_LIBRARY_ERROR, WALLET_STATUS } from './constants.js';
import { checkWalletRoot, isMissing } from './files.js';
import { createWalletLibrary, WalletLibraryError } from './library.js';
import type { WalletProtection } from './protection.js';
import { createWalletService } from './service.js';
import {
  unavailableCollection,
  type WalletCollection,
} from './settings-model.js';

export async function readWalletCollection(
  root: string,
  protection: WalletProtection | null,
): Promise<WalletCollection> {
  const result = await createWalletLibrary(root, protection).summary();
  const wallet = result.wallets.find(
    (item) => item.address === result.activeAddress,
  );
  if (!wallet)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  return { wallet, wallets: result.wallets };
}
export function failedWalletCollection(error: unknown) {
  return unavailableCollection(
    error instanceof WalletLibraryError &&
      (error.code === WALLET_LIBRARY_ERROR.UNAVAILABLE ||
        error.code === WALLET_LIBRARY_ERROR.BUSY)
      ? WALLET_STATUS.UNAVAILABLE
      : WALLET_STATUS.RECOVERY_REQUIRED,
  );
}
async function emptyRoot(root: string) {
  try {
    await checkWalletRoot(root);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  return (await readdir(root)).length === 0;
}
export async function prepareDesktopWallet(
  root: string,
  protection: WalletProtection | null,
  signal: AbortSignal,
) {
  if (signal.aborted || !protection) return unavailableCollection();
  try {
    if (!(await protection.available()) || signal.aborted)
      return unavailableCollection();
    const initialize = await emptyRoot(root);
    if (signal.aborted) return unavailableCollection();
    if (initialize) {
      const created = await createWalletService(root, protection).summary();
      if (created.status !== WALLET_STATUS.READY)
        return { wallet: created, wallets: [] };
    }
    if (signal.aborted) return unavailableCollection();
    return await readWalletCollection(root, protection);
  } catch (error) {
    return signal.aborted
      ? unavailableCollection()
      : failedWalletCollection(error);
  }
}
