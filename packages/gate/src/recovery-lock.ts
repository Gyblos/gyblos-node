import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';

import { FILE_MODES, P2P } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';

import { withExclusiveLock } from './lock.js';

interface RecoveryLockPaths {
  buyer: string;
  recovery: string;
  audit: string;
}

async function privateFile(handle: FileHandle) {
  const info = await handle.stat();
  assert.ok(Number.isSafeInteger(info.dev) && info.dev >= 0);
  assert.ok(Number.isSafeInteger(info.ino) && info.ino >= 0);
  assert.ok(
    info.isFile() && info.nlink === 1,
    'Private regular file required.',
  );
  assert.ok(process.geteuid, 'Local owner metadata is required.');
  assert.equal(info.uid, process.geteuid());
  assert.equal(info.mode & P2P.permissionMask, FILE_MODES.privateFile);
  return info;
}

async function removeDeadBuyerLock(paths: RecoveryLockPaths) {
  const handle = await open(
    paths.buyer,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    const info = await privateFile(handle);
    assert.ok(info.size > 0 && info.size <= P2P.lockMetadataBytes);
    const buffer = Buffer.alloc(P2P.lockMetadataBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert.ok(bytesRead > 0 && bytesRead <= P2P.lockMetadataBytes);
    const metadata: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString(),
    );
    assert.ok(metadata && typeof metadata === 'object');
    assert.ok('pid' in metadata && 'startedAt' in metadata);
    const { pid, startedAt } = metadata;
    assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
    assert.ok(
      typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt)),
    );
    let absent = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      absent = true;
    }
    if (!absent)
      throw new GateError(
        GATE_ERROR_CODES.BUYER_BUSY,
        'The original buyer process is still present; preserve its lock.',
      );
    const audit = await open(
      paths.audit,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      FILE_MODES.privateFile,
    );
    try {
      await privateFile(audit);
      await audit.writeFile(
        JSON.stringify({
          pid,
          startedAt,
          device: info.dev,
          inode: info.ino,
          recordedAt: new Date().toISOString(),
        }) + '\n',
      );
      await audit.sync();
    } finally {
      await audit.close();
    }
    const current = await lstat(paths.buyer);
    assert.ok(current.isFile() && current.nlink === 1);
    assert.equal(current.dev, info.dev);
    assert.equal(current.ino, info.ino);
    assert.equal(current.uid, info.uid);
    assert.equal(current.mode & P2P.permissionMask, FILE_MODES.privateFile);
    await unlink(paths.buyer);
  } finally {
    await handle.close();
  }
}

export async function withP2pRecoveryLock<T>(
  paths: RecoveryLockPaths,
  operation: () => Promise<T>,
): Promise<T> {
  return withExclusiveLock(paths.recovery, async () => {
    await removeDeadBuyerLock(paths);
    // A racing normal buyer may win this acquisition. Never retry or remove it.
    return withExclusiveLock(paths.buyer, operation);
  });
}
