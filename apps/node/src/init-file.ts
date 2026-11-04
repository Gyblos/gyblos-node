// Writes the gyblos.toml `gyblos seller init` produced: refuses a symlink or non-file at the target, replaces
// an existing file only with --force, and writes beside it before moving the file into place. Errors are
// InitError codes the command prints.
import { randomUUID } from 'node:crypto';
import { constants, link, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { INIT_ERRORS, INIT_FILE_MODE, type InitErrorCode } from './constants';

// A new file only, never through a symlink.
const NEW_FILE =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

export class InitError extends Error {
  constructor(
    readonly code: InitErrorCode,
    readonly subject?: string,
  ) {
    super(code);
  }
}

// An existing file is replaced only with --force, and never through a symlink or over a non-file.
export async function checkTarget(path: string, force: boolean) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw new InitError(INIT_ERRORS.WRITE_FAILED);
  }
  if (!stats.isFile()) throw new InitError(INIT_ERRORS.UNSAFE_PATH);
  if (!force) throw new InitError(INIT_ERRORS.FILE_EXISTS);
}

// Codes link() gives where the filesystem has no hard links (FAT, exFAT, some network mounts).
const NO_HARD_LINKS = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EXDEV',
  'ENOSYS',
]);
const errorCode = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined;

// A new file only (never through a symlink or over an existing file), with its mode and contents synced.
// A file this call created is removed again when its write fails; nothing is removed if it never opened.
async function writeNew(path: string, text: string) {
  const file = await open(path, NEW_FILE, INIT_FILE_MODE);
  try {
    await file.writeFile(text);
    // The umask may have narrowed the mode; the handle cannot be swapped for a symlink.
    await file.chmod(INIT_FILE_MODE);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
}

// Written and synced beside the target, then moved into place and the directory synced, so a reader never
// sees half a file. Without --force the move is a link, which fails if a file appeared meanwhile; where the
// filesystem has no hard links the file is created in place instead, still never over an existing one but
// not atomically, and removed again if that write fails.
export async function writeConfigFile(
  path: string,
  text: string,
  force: boolean,
  linkFile: (from: string, to: string) => Promise<void> = link,
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeNew(temporary, text);
    if (force) await rename(temporary, path);
    else
      await linkFile(temporary, path).catch(async (error: unknown) => {
        if (!NO_HARD_LINKS.has(String(errorCode(error)))) throw error;
        await writeNew(path, text);
      });
    const parent = await open(dirname(path), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw new InitError(INIT_ERRORS.FILE_EXISTS);
    throw new InitError(INIT_ERRORS.WRITE_FAILED);
  } finally {
    await rm(temporary, { force: true });
  }
}
