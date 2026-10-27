// Internal Node-only collection: preserves original custody, imports separately and selects explicitly.
// No UI/IPC/automatic creation, payment APIs, balance queries or native-store replacement.
import { mkdir } from 'node:fs/promises';

import { desktopWalletLibraryPaths } from '@gyblos/config/home';

import { createBackupCodec } from './backup/index.js';
import {
  WALLET,
  WALLET_LIBRARY,
  WALLET_LIBRARY_ERROR,
  WALLET_STATUS,
} from './constants.js';
import { checkWalletRoot, syncWalletDirectory } from './files.js';
import {
  checkLibraryCancellation,
  WalletLibraryError,
} from './library-error.js';
import {
  libraryAddresses,
  libraryExists,
  publishSelection,
  readSelection,
  withLibraryLock,
} from './library-files.js';
import {
  checkSelection,
  selectedAddress,
  selectionText,
} from './library-selection.js';
import type { WalletProtection } from './protection.js';
import { createWalletRestorer } from './restore.js';
import { createWalletService, readExistingWallet } from './service.js';

export { WALLET_LIBRARY_ERROR } from './constants.js';
export { WalletLibraryError } from './library-error.js';

function requireAddress(address: string | null): asserts address is string {
  if (!address)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
}
async function existing(root: string, protection: WalletProtection) {
  await checkWalletRoot(root);
  const summary = await readExistingWallet(root, protection);
  if (summary.status !== WALLET_STATUS.READY)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  return createWalletService(root, protection, Promise.resolve(summary));
}
async function entries(root: string, protection: WalletProtection) {
  const original = await existing(root, protection);
  const initial = await original.summary();
  requireAddress(initial.address);
  const wallets = new Map([[initial.address, original]]);
  if (await libraryExists(root)) {
    for (const address of await libraryAddresses(root)) {
      const wallet = await existing(
        desktopWalletLibraryPaths(root, address).identityRoot,
        protection,
      );
      if ((await wallet.summary()).address !== address || wallets.has(address))
        throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
      wallets.set(address, wallet);
    }
  }
  return { wallets, originalAddress: initial.address };
}
async function writeActive(
  root: string,
  protection: WalletProtection,
  wallet: Awaited<ReturnType<typeof existing>>,
  signal?: AbortSignal,
) {
  const text = await wallet.withSecret(async (secret, address) =>
    selectionText(secret, address),
  );
  const ciphertext = await protection.encrypt(text);
  try {
    if ((await protection.decrypt(ciphertext)) !== text)
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.UNAVAILABLE);
    checkLibraryCancellation(signal);
    // Atomic publication is the commit point; a cancellation after it cannot undo selection.
    await publishSelection(root, ciphertext);
  } finally {
    ciphertext.fill(0);
  }
}
async function selected(
  root: string,
  protection: WalletProtection,
  collection: Awaited<ReturnType<typeof entries>>,
) {
  if (!(await libraryExists(root))) return collection.originalAddress;
  const ciphertext = await readSelection(root);
  try {
    const text = await protection.decrypt(ciphertext);
    const address = selectedAddress(text).address;
    const wallet = collection.wallets.get(address);
    if (!wallet)
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
    await wallet.withSecret(async (secret) =>
      checkSelection(text, secret, address),
    );
    return address;
  } finally {
    ciphertext.fill(0);
  }
}
function libraryRunner(root: string, protection: WalletProtection | null) {
  async function run<T>(
    operation: (store: WalletProtection) => Promise<T>,
    signal?: AbortSignal,
  ) {
    try {
      checkLibraryCancellation(signal);
      if (!protection || !(await protection.available()))
        throw new WalletLibraryError(WALLET_LIBRARY_ERROR.UNAVAILABLE);
      return await withLibraryLock(root, async () => {
        checkLibraryCancellation(signal);
        return operation(protection);
      });
    } catch (error) {
      if (error instanceof WalletLibraryError) throw error;
      checkLibraryCancellation(signal);
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
    }
  }
  return run;
}
async function verifyAddressBackup(
  root: string,
  store: WalletProtection,
  address: string,
  file: Uint8Array,
  password: string,
  signal?: AbortSignal,
) {
  const collection = await entries(root, store);
  await selected(root, store, collection);
  const wallet = collection.wallets.get(address);
  if (!wallet)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  const secret = await createBackupCodec().open(
    file,
    password,
    address,
    signal,
  );
  await wallet.rememberBackup(secret, signal ?? new AbortController().signal);
}
export function createWalletLibrary(
  root: string,
  protection: WalletProtection | null,
) {
  const run = libraryRunner(root, protection);
  return {
    summary: () =>
      run(async (store) => {
        const collection = await entries(root, store);
        const activeAddress = await selected(root, store, collection);
        const wallets = await Promise.all(
          [...collection.wallets.values()].map((wallet) => wallet.summary()),
        );
        return { activeAddress, wallets };
      }),
    select: (address: string, signal?: AbortSignal) =>
      run(async (store) => {
        const collection = await entries(root, store);
        const active = await selected(root, store, collection);
        const wallet = collection.wallets.get(address);
        if (!wallet)
          throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
        if (active === address) return;
        await writeActive(root, store, wallet, signal);
      }, signal),
    restore: (file: Uint8Array, password: string, signal?: AbortSignal) =>
      run(async (store) => {
        const collection = await entries(root, store);
        await selected(root, store, collection);
        const recovered = await createBackupCodec().recover(
          file,
          password,
          signal,
        );
        if (collection.wallets.has(recovered.address))
          throw new WalletLibraryError(WALLET_LIBRARY_ERROR.EXISTS);
        if (collection.wallets.size >= WALLET_LIBRARY.MAX_IDENTITIES)
          throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
        checkLibraryCancellation(signal);
        if (!(await libraryExists(root))) {
          await mkdir(desktopWalletLibraryPaths(root).directory, {
            mode: WALLET.PRIVATE_DIRECTORY,
          });
          await syncWalletDirectory(root);
          await writeActive(
            root,
            store,
            collection.wallets.get(collection.originalAddress)!,
            signal,
          );
        }
        const destination = desktopWalletLibraryPaths(
          root,
          recovered.address,
        ).identityRoot;
        // Reuses authenticated portable recovery and exclusive protected publication.
        await createWalletRestorer(destination, store).restore(
          file,
          password,
          signal,
        );
        return (await existing(destination, store)).summary();
      }, signal),
    verifyBackup: (
      address: string,
      file: Uint8Array,
      password: string,
      signal?: AbortSignal,
    ) =>
      run(async (store) => {
        await verifyAddressBackup(root, store, address, file, password, signal);
      }, signal),
  };
}
