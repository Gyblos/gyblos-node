// Reads only user-selected bounded backup files and exclusively creates encrypted files.
// Never overwrites a destination or writes plaintext wallet material.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { BACKUP, BACKUP_ERROR } from './backup/constants.js';
import { BackupError } from './backup/error.js';
import { WALLET } from './constants.js';

export async function writeBackupFile(path: string, bytes: Uint8Array) {
  const file = await open(path, 'wx', WALLET.PRIVATE_FILE);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
    // Retain a failed encrypted write for inspection; never unlink a replaced path.
  }
}
export async function readBackupFile(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new BackupError(BACKUP_ERROR.INVALID_FILE);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size < 1 ||
      opened.size > BACKUP.MAX_FILE_BYTES ||
      opened.ino !== metadata.ino ||
      opened.dev !== metadata.dev
    )
      throw new BackupError(BACKUP_ERROR.INVALID_FILE);
    const bytes = Buffer.alloc(BACKUP.MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== opened.size)
      throw new BackupError(BACKUP_ERROR.INVALID_FILE);
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
