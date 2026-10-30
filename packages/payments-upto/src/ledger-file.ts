// Private file primitives for the upto ledger: an owner-only directory, bounded no-follow reads, an
// atomic durable write (temp, fsync, rename, directory fsync) and an exclusive lock file whose
// stale leftover from a crash can be taken over. Every failure is JOURNAL_UNAVAILABLE.
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import { UPTO_ERROR_CODES, UptoError } from 'x402-upto-metered';

import { FILE_MODES } from '@gyblos/config';

import { LEDGER_FILE } from './constants';

export function unavailable(): never {
  throw new UptoError(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE);
}

function owned(info: Stats, mode: number) {
  if (
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & FILE_MODES.permissionMask) !== mode
  )
    unavailable();
}

export async function ledgerDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: FILE_MODES.privateDirectory });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) unavailable();
  owned(info, FILE_MODES.privateDirectory);
}

export async function readLedger(path: string): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return unavailable();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > LEDGER_FILE.maxBytes)
      unavailable();
    owned(info, FILE_MODES.privateFile);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      await file.readFile(),
    );
  } finally {
    await file.close();
  }
}

export async function writeLedger(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > LEDGER_FILE.maxBytes) unavailable();
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    FILE_MODES.privateFile,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  if (process.platform !== 'win32') {
    const parent = await open(dirname(path), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeLock(path: string): Promise<boolean> {
  try {
    const file = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      FILE_MODES.privateFile,
    );
    await file.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return unavailable();
    return false;
  }
}

// Holds the lock for one read-modify-write. A lock older than staleMs was left by a crashed
// writer (writes take milliseconds) and is removed; a fresh one is waited for up to waitMs.
export async function withLedgerLock<T>(
  path: string,
  timing: { staleMs: number; waitMs: number },
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timing.waitMs;
  while (!(await takeLock(path))) {
    const info = await lstat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > timing.staleMs)
      await unlink(path).catch(() => {});
    else if (Date.now() >= deadline) return unavailable();
    else await pause(LEDGER_FILE.lockRetryMs);
  }
  try {
    return await run();
  } finally {
    await unlink(path).catch(() => {});
  }
}
