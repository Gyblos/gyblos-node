import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';

import { FILE_MODES, PRIVATE_LOG_LIMITS } from '@gyblos/config';

import { PRIVATE_LOG_CODES, type PrivateLogCode } from './constants.js';
import { reclaimOldestSlot } from './private-log-reclaim.js';

// Inodes of journals this process holds open; reclamation never removes them.
const OPEN_LOG_FILES = new Set<string>();

export interface PrivateLogFile {
  path: string;
  append(line: string): Promise<void>;
  close(): Promise<void>;
}

export interface PrivateLogFileOptions {
  reclaimMinAgeMs?: number;
}

function inodeKey(info: Pick<Stats, 'dev' | 'ino'>) {
  return info.dev + ':' + info.ino;
}

function slotLayout(names: readonly string[]) {
  const files = names.filter(
    (name) =>
      name.startsWith(PRIVATE_LOG_LIMITS.filenamePrefix) &&
      name.endsWith(PRIVATE_LOG_LIMITS.filenameSuffix),
  );
  const slotNames = Array.from(
    { length: PRIVATE_LOG_LIMITS.maxFiles },
    (_, index) =>
      PRIVATE_LOG_LIMITS.filenamePrefix +
      index +
      PRIVATE_LOG_LIMITS.filenameSuffix,
  );
  const legacyCount = files.filter((name) => !slotNames.includes(name)).length;
  const allowedSlots = slotNames.slice(
    0,
    Math.max(0, PRIVATE_LOG_LIMITS.maxFiles - legacyCount),
  );
  // Legacy files are never reclaimed; out-of-pool slots fail closed.
  if (
    files.some(
      (name) => slotNames.includes(name) && !allowedSlots.includes(name),
    )
  )
    throw new PrivateLogError(PRIVATE_LOG_CODES.STORAGE_LIMIT);
  return allowedSlots;
}

async function reserveSlot(allowedSlots: readonly string[], absolute: string) {
  for (const name of allowedSlots) {
    const path = join(absolute, name);
    try {
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        FILE_MODES.privateFile,
      );
      return { handle, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return undefined;
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
  options: PrivateLogFileOptions = {},
): Promise<PrivateLogFile> {
  const absolute = await directories(directory, true);
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
    let reserved: Awaited<ReturnType<typeof reserveSlot>>;
    // Each pass either reserves a slot or reclaims one; bounded by the pool.
    for (let pass = 0; pass <= PRIVATE_LOG_LIMITS.maxFiles; pass++) {
      const allowedSlots = slotLayout(await readdir(absolute));
      reserved = await reserveSlot(allowedSlots, absolute);
      if (reserved) break;
      await directories(absolute, false);
      await sameFile(directoryHandle, absolute, true);
      const reclaimed = await reclaimOldestSlot({
        directory: absolute,
        slotNames: allowedSlots,
        minAgeMs: options.reclaimMinAgeMs ?? PRIVATE_LOG_LIMITS.reclaimMinAgeMs,
        isOpen: (info) => OPEN_LOG_FILES.has(inodeKey(info)),
      });
      if (!reclaimed) break;
    }
    if (!reserved) throw new PrivateLogError(PRIVATE_LOG_CODES.STORAGE_LIMIT);
    const { path } = reserved;
    const fileHandle = (handle = reserved.handle);
    await sameFile(fileHandle, path);
    const key = inodeKey(await fileHandle.stat());
    OPEN_LOG_FILES.add(key);
    try {
      await fileHandle.sync();
      await directoryHandle.sync();
    } catch (error) {
      OPEN_LOG_FILES.delete(key);
      throw error;
    }
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
          OPEN_LOG_FILES.delete(key);
          await directoryHandle.close();
        }
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await directoryHandle.close().catch(() => {});
    // Preserve any created file; never unlink or repair a failed journal.
    throw error;
  }
}
