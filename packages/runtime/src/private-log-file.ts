import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';

import { FILE_MODES, PRIVATE_LOG_LIMITS } from '@gyblos/config';

import { PRIVATE_LOG_CODES, type PrivateLogCode } from './constants.js';

export interface PrivateLogFile {
  path: string;
  append(line: string): Promise<void>;
  close(): Promise<void>;
}

function rejectUnsafe() {
  throw new PrivateLogError(PRIVATE_LOG_CODES.UNSAFE_PATH);
}

async function directories(path: string, create: boolean) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: FILE_MODES.privateDirectory });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) rejectUnsafe();
    if (
      current === absolute &&
      ((process.getuid && info.uid !== process.getuid()) ||
        (info.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0 ||
        (info.mode & constants.S_IRWXU) !== FILE_MODES.privateDirectory)
    )
      rejectUnsafe();
  }
  return absolute;
}

async function sameFile(handle: FileHandle, path: string, directory = false) {
  const opened = await handle.stat();
  const named = await lstat(path);
  if (
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    (process.getuid && opened.uid !== process.getuid()) ||
    (opened.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0 ||
    (opened.mode & constants.S_IRWXU) !==
      (directory ? FILE_MODES.privateDirectory : FILE_MODES.privateFile) ||
    (directory ? !opened.isDirectory() : !opened.isFile() || opened.nlink !== 1)
  )
    rejectUnsafe();
}

export class PrivateLogError extends Error {
  constructor(readonly code: PrivateLogCode) {
    super(code);
  }
}

export async function openPrivateLogFile(
  directory: string,
): Promise<PrivateLogFile> {
  const absolute = await directories(directory, true);
  const files = (await readdir(absolute)).filter(
    (name) =>
      name.startsWith(PRIVATE_LOG_LIMITS.filenamePrefix) &&
      name.endsWith(PRIVATE_LOG_LIMITS.filenameSuffix),
  );
  if (files.length >= PRIVATE_LOG_LIMITS.maxFiles)
    throw new PrivateLogError(PRIVATE_LOG_CODES.STORAGE_LIMIT);
  const directoryHandle = await open(
    absolute,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  let handle: FileHandle | undefined;
  try {
    await sameFile(directoryHandle, absolute, true);
    const slotNames = Array.from(
      { length: PRIVATE_LOG_LIMITS.maxFiles },
      (_, index) =>
        PRIVATE_LOG_LIMITS.filenamePrefix +
        index +
        PRIVATE_LOG_LIMITS.filenameSuffix,
    );
    const legacyCount = files.filter(
      (name) => !slotNames.includes(name),
    ).length;
    const allowedSlots = slotNames.slice(
      0,
      PRIVATE_LOG_LIMITS.maxFiles - legacyCount,
    );
    if (
      files.some(
        (name) => slotNames.includes(name) && !allowedSlots.includes(name),
      )
    )
      throw new PrivateLogError(PRIVATE_LOG_CODES.STORAGE_LIMIT);
    let path = '';
    for (const name of allowedSlots) {
      path = join(absolute, name);
      try {
        handle = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          FILE_MODES.privateFile,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!handle) throw new PrivateLogError(PRIVATE_LOG_CODES.STORAGE_LIMIT);
    const fileHandle = handle;
    await sameFile(fileHandle, path);
    await fileHandle.sync();
    await directoryHandle.sync();
    return {
      path,
      async append(line: string) {
        await directories(absolute, false);
        await sameFile(directoryHandle, absolute, true);
        await sameFile(fileHandle, path);
        await fileHandle.writeFile(line, 'utf8');
        await fileHandle.sync();
        await sameFile(fileHandle, path);
        await sameFile(directoryHandle, absolute, true);
      },
      async close() {
        try {
          await fileHandle.close();
        } finally {
          await directoryHandle.close();
        }
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await directoryHandle.close().catch(() => {});
    // Preserve any created file; never unlink, repair or rotate diagnostics.
    throw error;
  }
}
