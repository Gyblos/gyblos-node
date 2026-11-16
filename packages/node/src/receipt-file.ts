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
import { hasPrivateMode } from '@gyblos/runtime/private-mode';

import { NODE_ERROR_CODES, RECEIPT_UPLOAD } from './constants';
import { NodeError } from './errors';

export function receiptUnavailable(): never {
  throw new NodeError(NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE);
}
export async function receiptBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof NodeError &&
      error.code === NODE_ERROR_CODES.RECEIPT_STORAGE_FULL
    )
      throw error;
    return receiptUnavailable();
  }
}
export function receiptSignal(signal?: AbortSignal) {
  if (signal?.aborted) receiptUnavailable();
}
function privateMode(info: Stats, directory: boolean) {
  if (
    !hasPrivateMode(
      info,
      directory ? FILE_MODES.privateDirectory : FILE_MODES.privateFile,
    )
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
        opened.size > RECEIPT_UPLOAD.maxLogBytes)
  )
    receiptUnavailable();
  privateMode(opened, directory);
  return opened;
}
const revision = (info: Stats) =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
export async function receiptFileRevision(path: string) {
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
    return revision(await checked(file, path));
  } finally {
    await file.close();
  }
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
    if (read.bytesRead !== info.size || revision(after) !== revision(info))
      receiptUnavailable();
    const complete = bytes.subarray(0, read.bytesRead).lastIndexOf('\n') + 1;
    if (!complete) receiptUnavailable();
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, complete),
      ),
      complete,
      size: info.size,
      revision: revision(after),
    };
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
  expected?: string,
) {
  if (Buffer.byteLength(text) > RECEIPT_UPLOAD.maxLogBytes)
    receiptUnavailable();
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
    if ((await receiptFileRevision(path)) !== expected) receiptUnavailable();
    await rename(temporary, path);
    if (process.platform !== 'win32') await parent.sync();
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await parent.close();
  }
}

// A complete newline is the journal commit boundary. A crash-torn tail is removed only under the lock.
export async function appendReceiptFile(
  path: string,
  text: string,
  expected: string,
  complete: number,
  signal?: AbortSignal,
) {
  const bytes = Buffer.from(text);
  if (complete + bytes.length > RECEIPT_UPLOAD.maxLogBytes)
    receiptUnavailable();
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let file: FileHandle | undefined;
  try {
    await checked(parent, dirname(path), true);
    file = await open(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (revision(await checked(file, path)) !== expected) receiptUnavailable();
    await checked(parent, dirname(path), true);
    receiptSignal(signal);
    if ((await file.stat()).size !== complete) await file.truncate(complete);
    let offset = 0;
    while (offset < bytes.length) {
      const written = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        complete + offset,
      );
      if (!written.bytesWritten) receiptUnavailable();
      offset += written.bytesWritten;
    }
    await file.sync();
    await checked(parent, dirname(path), true);
    const after = await checked(file, path);
    if (after.size !== complete + bytes.length) receiptUnavailable();
    return {
      revision: revision(after),
      complete: after.size,
      size: after.size,
    };
  } finally {
    await file?.close();
    await parent.close();
  }
}
