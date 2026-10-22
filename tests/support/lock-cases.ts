import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FILE_MODES } from '@gyblos/config';
import { LOCK_OWNER } from '@gyblos/config/lock';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { currentLockOwner } from '@gyblos/payments-x402/recovery/lock-owner';
import { withP2pRecoveryLock } from '@gyblos/payments-x402/recovery/recovery-lock';

import { registerLockFaultCases } from './lock-faults.js';
import { lockFixture } from './lock-fixture.js';

const LOCAL_OWNER_SUPPORTED =
  process.platform === 'darwin' || process.platform === 'linux';

export function registerLockCases() {
  registerLockFaultCases();
  test(
    'local lock owner contains the current host, boot identity and PID namespace',
    { skip: !LOCAL_OWNER_SUPPORTED },
    async () => {
      const owner = await currentLockOwner();
      assert.ok(owner);
      assert.equal(owner.version, LOCK_OWNER.schemaVersion);
      assert.equal(owner.platform, process.platform);
      assert.equal(owner.host, hostname());
      const bootId =
        process.platform === 'linux'
          ? (await readFile(LOCK_OWNER.linuxBootIdPath, 'utf8')).trim()
          : (
              await promisify(execFile)(LOCK_OWNER.darwinBootTool, [
                '-n',
                LOCK_OWNER.darwinBootKey,
              ])
            ).stdout.trim();
      assert.equal(owner.bootId, bootId.toLowerCase());
      assert.equal(
        owner.pidNamespace,
        process.platform === 'linux'
          ? await readlink(LOCK_OWNER.linuxPidNamespacePath)
          : process.platform,
      );
    },
  );
  test(
    'dead local buyer retirement writes an audit before entering recovery',
    { skip: !LOCAL_OWNER_SUPPORTED },
    async () => {
      const fixture = await lockFixture();
      try {
        let entered = false;
        await withP2pRecoveryLock(fixture.paths, async () => {
          entered = true;
          assert.ok(
            (await readFile(fixture.paths.audit, 'utf8')).includes(
              String(fixture.metadata.pid),
            ),
          );
        });
        assert.equal(entered, true);
        await assert.rejects(stat(fixture.paths.buyer), { code: 'ENOENT' });
      } finally {
        await fixture.close();
      }
    },
  );
  for (const fault of [
    'live PID',
    'foreign host',
    'foreign boot',
    'foreign namespace',
    'missing owner',
    'symlink',
    'hardlink',
  ] as const) {
    test(
      'recovery preserves an unsafe original lock: ' + fault,
      { skip: !LOCAL_OWNER_SUPPORTED },
      async () => {
        const fixture = await lockFixture();
        try {
          const metadata: Record<string, unknown> = structuredClone(
            fixture.metadata,
          );
          if (fault === 'live PID') metadata.pid = process.pid;
          else if (fault === 'missing owner') delete metadata.owner;
          else if (fault.startsWith('foreign'))
            metadata.owner = {
              ...fixture.metadata.owner,
              [fault === 'foreign host'
                ? 'host'
                : fault === 'foreign boot'
                  ? 'bootId'
                  : 'pidNamespace']: 'another-domain',
            };
          await writeFile(fixture.paths.buyer, JSON.stringify(metadata));
          const original = await readFile(fixture.paths.buyer, 'utf8');
          if (fault === 'symlink') {
            const target = join(fixture.directory, 'target');
            await writeFile(target, original, { mode: FILE_MODES.privateFile });
            await unlink(fixture.paths.buyer);
            await symlink(target, fixture.paths.buyer);
          }
          if (fault === 'hardlink')
            await link(
              fixture.paths.buyer,
              join(fixture.directory, 'other-link'),
            );
          let entered = false;
          await assert.rejects(
            withP2pRecoveryLock(fixture.paths, async () => {
              entered = true;
            }),
          );
          assert.equal(entered, false);
          assert.equal(await readFile(fixture.paths.buyer, 'utf8'), original);
        } finally {
          await fixture.close();
        }
      },
    );
  }
  for (const target of ['buyer', 'audit'] as const)
    test(
      'FIFO ' + target + ' is refused without entering or blocking recovery',
      { skip: !LOCAL_OWNER_SUPPORTED, timeout: 5000 },
      async () => {
        const fixture = await lockFixture();
        try {
          if (target === 'buyer') await unlink(fixture.paths.buyer);
          const fifo = spawnSync(
            'mkfifo',
            ['-m', '600', fixture.paths[target]],
            { encoding: 'utf8' },
          );
          assert.equal(fifo.status, 0, fifo.stderr);
          const result = await promisify(execFile)(
            process.execPath,
            [
              '--import',
              'tsx',
              fileURLToPath(new URL('./lock-probe.ts', import.meta.url)),
              JSON.stringify(fixture.paths),
            ],
            { timeout: 2000 },
          );
          assert.deepEqual(JSON.parse(result.stdout), {
            rejected: true,
            entered: false,
          });
          assert.equal((await lstat(fixture.paths[target])).isFIFO(), true);
        } finally {
          await fixture.close();
        }
      },
    );
  test('exclusive-lock cleanup preserves a different inode and original operation error', async () => {
    const directory = await mkdtemp(
        join(tmpdir(), 'gyblos-public-lock-cleanup-'),
      ),
      path = join(directory, 'owned.lock'),
      failure = new Error('Synthetic operation failure');
    try {
      await assert.rejects(
        withExclusiveLock(path, async () => {
          const original = await stat(path);
          await unlink(path);
          await writeFile(path, 'replacement', {
            mode: FILE_MODES.privateFile,
          });
          assert.notEqual((await stat(path)).ino, original.ino);
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.equal(await readFile(path, 'utf8'), 'replacement');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
