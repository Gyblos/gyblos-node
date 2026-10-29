// Bounded private receipt files and exclusive update locks; no keys or payment journals are opened.
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
import { dirname, join, parse, resolve, sep } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import { NODE_ERROR_CODES, RECEIPT_STORAGE } from './constants';
import { NodeError } from './errors';

export function receiptUnavailable(): never {
  throw new NodeError(NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE);
}
export function receiptSignal(signal?: AbortSignal) {
  if (signal?.aborted) receiptUnavailable();
}
function privateMode(info: Stats, directory: boolean) {
  if (
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & FILE_MODES.permissionMask) !==
      (directory ? FILE_MODES.privateDirectory : FILE_MODES.privateFile)
  )
    receiptUnavailable();
}
export async function receiptDirectory(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: FILE_MODES.privateDirectory });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) receiptUnavailable();
    if (current === absolute) privateMode(info, true);
  }
}
async function checked(file: FileHandle, path: string, directory = false) {
  const opened = await file.stat();
  const named = await lstat(path);
  if (
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    (directory
      ? !opened.isDirectory()
      : !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size > RECEIPT_STORAGE.maxBytes)
  )
    receiptUnavailable();
  privateMode(opened, directory);
  return opened;
}
export async function readReceiptFile(path: string) {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await checked(file, path);
    const bytes = Buffer.alloc(info.size + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    const after = await checked(file, path);
    if (read.bytesRead !== info.size || after.size !== info.size)
      receiptUnavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, read.bytesRead),
    );
  } finally {
    await file.close();
  }
}
export async function receiptLock(path: string) {
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    FILE_MODES.privateFile,
  );
  try {
    await checked(file, path);
  } catch (error) {
    await file.close();
    throw error;
  }
  return async () => {
    try {
      await checked(file, path);
      await unlink(path);
    } finally {
      await file.close();
    }
  };
}
export async function writeReceiptFile(
  path: string,
  text: string,
  signal?: AbortSignal,
) {
  if (Buffer.byteLength(text) > RECEIPT_STORAGE.maxBytes) receiptUnavailable();
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: FileHandle | undefined;
  try {
    await checked(parent, dirname(path), true);
    receiptSignal(signal);
    file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      FILE_MODES.privateFile,
    );
    await file.writeFile(text);
    await file.sync();
    await checked(file, temporary);
    await file.close();
    file = undefined;
    await checked(parent, dirname(path), true);
    receiptSignal(signal);
    await rename(temporary, path);
    if (process.platform !== 'win32') await parent.sync();
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await parent.close();
  }
}
