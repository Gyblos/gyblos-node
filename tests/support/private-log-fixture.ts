import fsPromises, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

export const PRIVATE_LOG_PLATFORM_SKIP =
  process.platform === 'win32'
    ? 'Private log ownership, modes and directory fsync require macOS or Linux'
    : false;

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
