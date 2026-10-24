// Owns private local wallet records; never reads node role homes or follows symlinks.
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { WALLET } from './constants.js';

export function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function syncWalletDirectory(path: string) {
  // Windows does not support this POSIX directory flush. Do not claim equivalent
  // sudden-power-loss durability there; ordinary restart is independently tested.
  if (process.platform === 'win32') return;
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function privateMetadata(metadata: Stats, directory: boolean) {
  if (
    metadata.isSymbolicLink() ||
    (directory ? !metadata.isDirectory() : !metadata.isFile())
  )
    throw new Error('Invalid wallet storage.');
  if (
    process.platform !== 'win32' &&
    ((metadata.mode & WALLET.PERMISSION_MASK) !==
      (directory ? WALLET.PRIVATE_DIRECTORY : WALLET.PRIVATE_FILE) ||
      metadata.uid !== process.getuid?.())
  )
    throw new Error('Invalid wallet storage permissions.');
}

export async function ensureWalletRoot(root: string) {
  try {
    await mkdir(root, { mode: WALLET.PRIVATE_DIRECTORY });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  privateMetadata(await lstat(root), true);
  await syncWalletDirectory(dirname(root));
}

export async function readWalletRecord(directory: string) {
  privateMetadata(await lstat(directory), true);
  const path = join(directory, WALLET.RECORD);
  privateMetadata(await lstat(path), false);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    privateMetadata(metadata, false);
    if (metadata.size > WALLET.MAX_RECORD_BYTES || metadata.size === 0)
      throw new Error('Invalid wallet record size.');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    return value;
  } finally {
    await file.close();
  }
}

export async function writeNewWallet(directory: string, contents: string) {
  const path = join(directory, WALLET.STAGING);
  const file = await open(path, 'wx', WALLET.PRIVATE_FILE);
  try {
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  // Only the process that exclusively created the directory may publish once.
  await rename(path, join(directory, WALLET.RECORD));
  await syncWalletDirectory(directory);
}
