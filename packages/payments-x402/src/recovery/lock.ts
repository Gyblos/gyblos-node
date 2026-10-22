import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import { GateError } from '../chain.js';
import { GATE_ERROR_CODES } from '../constants.js';
import { currentLockOwner } from './lock-owner.js';

async function removeOwnedLock(path: string, handle: FileHandle) {
  const owned = await handle.stat({ bigint: true });
  const current = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (
    current?.isFile() &&
    current.dev === owned.dev &&
    current.ino === owned.ino
  )
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
}

export async function withExclusiveLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const handle = await open(path, 'wx', FILE_MODES.privateFile).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GateError(
          GATE_ERROR_CODES.BUYER_BUSY,
          'Another buyer or an interrupted process holds the gate lock. Reconcile before removing a stale lock.',
        );
      throw error;
    },
  );
  let operationFailed = false;
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        owner: await currentLockOwner(),
      }),
    );
    await handle.sync();
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await removeOwnedLock(path, handle);
    } catch (error) {
      if (!operationFailed) throw error;
    } finally {
      await handle.close().catch((error) => {
        if (!operationFailed) throw error;
      });
    }
  }
}
