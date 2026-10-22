// Owns lock owner in payments-x402; it must not know inference engines or lab orchestration.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import { LOCK_OWNER } from '@gyblos/config/lock';

export interface LockOwner {
  version: typeof LOCK_OWNER.schemaVersion;
  platform: NodeJS.Platform;
  host: string;
  bootId: string;
  pidNamespace: string;
}

export async function currentLockOwner(): Promise<LockOwner | null> {
  try {
    const platform = process.platform;
    if (platform !== 'linux' && platform !== 'darwin') return null;
    const host = hostname();
    assert.ok(host && host === host.trim());
    const bootId = (
      platform === 'linux'
        ? await readFile(LOCK_OWNER.linuxBootIdPath, 'utf8')
        : (
            await promisify(execFile)(
              LOCK_OWNER.darwinBootTool,
              ['-n', LOCK_OWNER.darwinBootKey],
              {
                timeout: LOCK_OWNER.readTimeoutMs,
                maxBuffer: LOCK_OWNER.maxOutputBytes,
                encoding: 'utf8',
              },
            )
          ).stdout
    )
      .trim()
      .toLowerCase();
    assert.match(
      bootId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const pidNamespace =
      platform === 'linux'
        ? await readlink(LOCK_OWNER.linuxPidNamespacePath)
        : platform;
    if (platform === 'linux') assert.match(pidNamespace, /^pid:\[\d+\]$/);
    return {
      version: LOCK_OWNER.schemaVersion,
      platform,
      host,
      bootId,
      pidNamespace,
    };
  } catch {
    // Normal locking remains usable; unverifiable owners require manual recovery.
    return null;
  }
}
