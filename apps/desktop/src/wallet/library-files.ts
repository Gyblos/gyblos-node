// Serializes independent library instances and publishes only protected selection metadata.
// Interrupted claims/locks are retained for recovery; never steals a lock or deletes custody.
import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises';

import {
  DESKTOP_WALLET_LIBRARY,
  desktopWalletLibraryPaths,
} from '@gyblos/config/home';

import { readBackupFile, writeBackupFile } from './backup-files';
import { WALLET, WALLET_LIBRARY, WALLET_LIBRARY_ERROR } from './constants';
import { checkWalletRoot, isMissing, syncWalletDirectory } from './files';
import { checkLibraryCancellation, WalletLibraryError } from './library-error';

export async function libraryExists(root: string) {
  try {
    await checkWalletRoot(desktopWalletLibraryPaths(root).directory);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
export async function libraryAddresses(root: string) {
  const path = desktopWalletLibraryPaths(root).directory;
  await checkWalletRoot(path);
  const entries = await readdir(path);
  const names = entries.filter(
    (name) =>
      name !== DESKTOP_WALLET_LIBRARY.ACTIVE &&
      name !== DESKTOP_WALLET_LIBRARY.PENDING,
  );
  if (names.length >= WALLET_LIBRARY.MAX_IDENTITIES)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  for (const name of names)
    await checkWalletRoot(desktopWalletLibraryPaths(root, name).identityRoot);
  return names.sort();
}
export async function readSelection(root: string) {
  const paths = desktopWalletLibraryPaths(root);
  await checkWalletRoot(paths.directory);
  const metadata = await lstat(paths.active);
  if (
    metadata.size > WALLET_LIBRARY.MAX_ACTIVE_BYTES ||
    metadata.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((metadata.mode & WALLET.PERMISSION_MASK) !== WALLET.PRIVATE_FILE ||
        metadata.uid !== process.getuid?.()))
  )
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  return readBackupFile(paths.active);
}
export async function publishSelection(
  root: string,
  bytes: Buffer,
  signal?: AbortSignal,
) {
  const paths = desktopWalletLibraryPaths(root);
  await checkWalletRoot(paths.directory);
  const reserved = await lstat(paths.directory);
  await writeBackupFile(paths.pending, bytes);
  const current = await lstat(paths.directory);
  await checkWalletRoot(paths.directory);
  if (current.dev !== reserved.dev || current.ino !== reserved.ino)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  checkLibraryCancellation(signal);
  await rename(paths.pending, paths.active);
  await syncWalletDirectory(paths.directory);
}
export async function withLibraryLock<T>(
  root: string,
  operation: () => Promise<T>,
) {
  await checkWalletRoot(root);
  const path = desktopWalletLibraryPaths(root).lock;
  try {
    await mkdir(path, { mode: WALLET.PRIVATE_DIRECTORY });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.BUSY);
    throw error;
  }
  const reserved = await lstat(path);
  try {
    return await operation();
  } finally {
    const current = await lstat(path);
    await checkWalletRoot(path);
    if (current.dev !== reserved.dev || current.ino !== reserved.ino)
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
    await rmdir(path);
  }
}
