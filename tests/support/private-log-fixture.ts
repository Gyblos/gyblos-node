import fsPromises, {
  lstat,
  readdir,
  readFile,
  readlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';

export const PRIVATE_LOG_PLATFORM_SKIP =
  process.platform === 'win32'
    ? 'Private log ownership, modes and directory fsync require macOS or Linux'
    : false;

export const SETTLED_AGE_SECONDS = 24 * 60 * 60;

type PatchableFs = 'lstat' | 'rename';

interface LogIo {
  sync?: () => Promise<void>;
  write?: (
    data: string,
    proceed: (data: string) => Promise<void>,
  ) => Promise<void>;
  openError?: Error;
  beforeFileOpen?: () => Promise<void>;
  close?: () => Promise<void>;
  fileFlags: number[];
  fileSyncs: number;
  directorySyncs: number;
  warnings: string[];
}

export async function withLogIo<T>(run: (io: LogIo) => Promise<T>) {
  const originalOpen = fsPromises.open;
  const originalWarning = console.error;
  const io: LogIo = {
    fileFlags: [],
    fileSyncs: 0,
    directorySyncs: 0,
    warnings: [],
  };
  fsPromises.open = async (path, flags, mode) => {
    const file = typeof path === 'string' && path.endsWith('.jsonl');
    if (file) await io.beforeFileOpen?.();
    if (file && io.openError) throw io.openError;
    const handle: FileHandle = await originalOpen(path, flags, mode);
    if (file && typeof flags === 'number') io.fileFlags.push(flags);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      if (file) await io.close?.();
      return originalClose();
    };
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (file) {
        io.fileSyncs++;
        await io.sync?.();
      } else io.directorySyncs++;
      return originalSync();
    };
    if (file) {
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (data, options) => {
        if (typeof data === 'string' && io.write)
          return io.write(data, (replacement) =>
            originalWrite(replacement, options),
          );
        return originalWrite(data, options);
      };
    }
    return handle;
  };
  console.error = (...values: unknown[]) => {
    io.warnings.push(
      values
        .map((value) =>
          typeof value === 'string' ? value : 'UNEXPECTED_WARNING_OBJECT',
        )
        .join(' '),
    );
  };
  syncBuiltinESMExports();
  try {
    return await run(io);
  } finally {
    fsPromises.open = originalOpen;
    console.error = originalWarning;
    syncBuiltinESMExports();
  }
}

export function slotName(index: number | string) {
  return (
    PRIVATE_LOG_LIMITS.filenamePrefix +
    index +
    PRIVATE_LOG_LIMITS.filenameSuffix
  );
}

/** Creates a private journal whose last append is `ageSeconds` in the past. */
export async function seedJournal(
  directory: string,
  name: string,
  ageSeconds: number,
) {
  const path = join(directory, name);
  await writeFile(path, name + '\n', { mode: 0o600, flag: 'wx' });
  const time = new Date(Date.now() - ageSeconds * 1000);
  await utimes(path, time, time);
  return path;
}

/** Inode and content of every entry, to prove nothing was replaced. */
export async function directorySnapshot(directory: string) {
  const entries: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    entries[name] =
      info.ino +
      ':' +
      (info.isSymbolicLink()
        ? 'link->' + (await readlink(path))
        : info.isFile()
          ? await readFile(path, 'utf8')
          : 'directory');
  }
  return entries;
}

export async function withFsPatch<Name extends PatchableFs, T>(
  name: Name,
  wrap: (original: (typeof fsPromises)[Name]) => (typeof fsPromises)[Name],
  run: () => Promise<T>,
) {
  const original = fsPromises[name];
  fsPromises[name] = wrap(original);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fsPromises[name] = original;
    syncBuiltinESMExports();
  }
}
