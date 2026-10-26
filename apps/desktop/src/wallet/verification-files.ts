// Keeps only bounded OS-protected verification metadata beside the current wallet.
// Atomic publication replaces metadata only; wallet records and selected backups are never replaced.
import { randomUUID } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readBackupFile, writeBackupFile } from './backup-files.js';
import { BACKUP_VERIFICATION, WALLET } from './constants.js';
import { checkWalletRoot, syncWalletDirectory } from './files.js';

async function directory(root: string) {
  await checkWalletRoot(root);
  const path = join(root, WALLET.DIRECTORY);
  await checkWalletRoot(path);
  return path;
}
export async function readVerification(root: string) {
  const path = join(await directory(root), BACKUP_VERIFICATION.RECORD);
  const metadata = await lstat(path);
  if (
    metadata.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((metadata.mode & WALLET.PERMISSION_MASK) !== WALLET.PRIVATE_FILE ||
        metadata.uid !== process.getuid?.()))
  )
    throw new Error('Invalid backup metadata storage.');
  return readBackupFile(path);
}
export async function writeVerification(
  root: string,
  ciphertext: Uint8Array,
  signal: AbortSignal,
) {
  const path = await directory(root);
  const reserved = await lstat(path);
  const temporary = join(
    path,
    `${BACKUP_VERIFICATION.RECORD}.${randomUUID()}.pending`,
  );
  try {
    if (signal.aborted) throw new Error('Backup metadata cancelled.');
    await writeBackupFile(temporary, ciphertext);
    const current = await lstat(await directory(root));
    if (
      signal.aborted ||
      current.dev !== reserved.dev ||
      current.ino !== reserved.ino
    )
      throw new Error('Backup metadata cancelled or unavailable.');
    // Publishing is the commit point. An already-started rename may finish on quit.
    await rename(temporary, join(path, BACKUP_VERIFICATION.RECORD));
    await syncWalletDirectory(path);
  } finally {
    await rm(temporary, { force: true });
  }
}
