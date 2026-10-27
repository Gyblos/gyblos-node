// Opens bounded private identity metadata and atomically replaces it after durable writes.
// No keys or payment journals; unsafe files/directories fail closed and are never repaired.
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import { IDENTITY_STATE } from './constants';
import { identityStateUnavailable } from './identity-state-schema';

function owned(info: Stats) {
  return !process.getuid || info.uid === process.getuid();
}
export async function identityDirectory(directory: string) {
  const absolute = resolve(directory);
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
    if (!info.isDirectory() || info.isSymbolicLink())
      identityStateUnavailable();
    if (
      current === absolute &&
      (!owned(info) ||
        (info.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateDirectory)
    )
      identityStateUnavailable();
  }
  return absolute;
}
async function checkedFile(file: FileHandle, path: string) {
  const info = await file.stat();
  const named = await lstat(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    !owned(info) ||
    named.isSymbolicLink() ||
    info.dev !== named.dev ||
    info.ino !== named.ino ||
    (info.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateFile ||
    info.size > IDENTITY_STATE.maxBytes
  )
    identityStateUnavailable();
  return info;
}
export async function readIdentityFile(path: string) {
  let file;
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
    const info = await checkedFile(file, path);
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await checkedFile(file, path);
    if (bytesRead !== info.size || after.size !== info.size)
      identityStateUnavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
  } finally {
    await file.close();
  }
}
export async function writeIdentityFile(path: string, bytes: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', FILE_MODES.privateFile);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await checkedFile(file, temporary);
    await file.close();
    await identityDirectory(dirname(path));
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
export async function acquireIdentityLock(path: string) {
  const file = await open(path, 'wx', FILE_MODES.privateFile);
  try {
    await checkedFile(file, path);
  } catch (error) {
    await file.close();
    throw error;
  }
  return async () => {
    try {
      await checkedFile(file, path);
      await rm(path);
    } finally {
      await file.close();
    }
  };
}
