import assert from 'node:assert/strict';
import {
  link,
  lstat,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { withP2pRecoveryLock } from '@gyblos/gate/recovery-lock';

import {
  interceptAuditSync,
  interceptOpen,
  lockFixture,
  restoreFileMocks,
} from './lock-fixture.js';

const LOCAL_OWNER_SUPPORTED =
  process.platform === 'darwin' || process.platform === 'linux';

export function registerLockFaultCases() {
  test(
    'pre-unlink recheck rejects an inode swapped after the durable audit',
    { skip: !LOCAL_OWNER_SUPPORTED },
    async (context) => {
      const fixture = await lockFixture();
      let entered = false,
        swapped = false;
      try {
        const original = await lstat(fixture.paths.buyer);
        const replacement = join(fixture.directory, 'replacement');
        await writeFile(replacement, 'replacement', {
          mode: FILE_MODES.privateFile,
        });
        const replacementInfo = await lstat(replacement);
        assert.notEqual(replacementInfo.ino, original.ino);
        interceptAuditSync(context, fixture.paths.audit, async () => {
          await rename(replacement, fixture.paths.buyer);
          swapped = true;
        });
        await assert.rejects(
          withP2pRecoveryLock(fixture.paths, async () => {
            entered = true;
          }),
          (error: unknown) => {
            assert.ok(error instanceof assert.AssertionError);
            assert.equal(error.actual, replacementInfo.ino);
            assert.equal(error.expected, original.ino);
            return true;
          },
        );
        assert.equal(swapped, true);
        assert.equal(entered, false);
        assert.equal(
          (await lstat(fixture.paths.buyer)).ino,
          replacementInfo.ino,
        );
        assert.equal(
          await readFile(fixture.paths.buyer, 'utf8'),
          'replacement',
        );
        assert.equal(
          JSON.parse(await readFile(fixture.paths.audit, 'utf8')).inode,
          original.ino,
        );
      } finally {
        restoreFileMocks(context);
        await fixture.close();
      }
    },
  );

  test(
    'initial nlink guard rejects before an audit open could normalize the link count',
    { skip: !LOCAL_OWNER_SUPPORTED },
    async (context) => {
      const fixture = await lockFixture();
      let entered = false,
        auditOpened = false;
      try {
        const other = join(fixture.directory, 'other-link');
        await link(fixture.paths.buyer, other);
        interceptOpen(context, async (path) => {
          if (path === fixture.paths.audit) {
            auditOpened = true;
            await unlink(other);
          }
        });
        await assert.rejects(
          withP2pRecoveryLock(fixture.paths, async () => {
            entered = true;
          }),
          /^AssertionError.*Private regular file required\./,
        );
        assert.equal(auditOpened, false);
        assert.equal(entered, false);
        assert.equal((await lstat(fixture.paths.buyer)).nlink, 2);
      } finally {
        restoreFileMocks(context);
        await fixture.close();
      }
    },
  );

  test(
    'pre-unlink nlink guard rejects a hardlink added after the durable audit',
    { skip: !LOCAL_OWNER_SUPPORTED },
    async (context) => {
      const fixture = await lockFixture();
      let entered = false,
        linked = false;
      try {
        interceptAuditSync(context, fixture.paths.audit, async () => {
          await link(
            fixture.paths.buyer,
            join(fixture.directory, 'other-link'),
          );
          linked = true;
        });
        await assert.rejects(
          withP2pRecoveryLock(fixture.paths, async () => {
            entered = true;
          }),
          { code: 'ERR_ASSERTION' },
        );
        assert.equal(linked, true);
        assert.equal(entered, false);
        assert.equal((await lstat(fixture.paths.buyer)).nlink, 2);
      } finally {
        restoreFileMocks(context);
        await fixture.close();
      }
    },
  );

  for (const target of ['buyer', 'audit'] as const)
    test(
      'O_NOFOLLOW rejects the ' +
        target +
        ' symlink at open before path normalization',
      { skip: !LOCAL_OWNER_SUPPORTED },
      async (context) => {
        const fixture = await lockFixture();
        let entered = false,
          opened = false;
        try {
          const path = fixture.paths[target],
            destination = join(fixture.directory, 'symlink-target');
          const original =
            target === 'buyer' ? await readFile(path, 'utf8') : 'audit-target';
          await writeFile(destination, original, {
            mode: FILE_MODES.privateFile,
          });
          if (target === 'buyer') await unlink(path);
          await symlink(destination, path);
          interceptOpen(context, async (openedPath) => {
            if (openedPath === path) {
              opened = true;
              if (target === 'buyer') await rename(destination, path);
            }
          });
          await assert.rejects(
            withP2pRecoveryLock(fixture.paths, async () => {
              entered = true;
            }),
            { code: 'ELOOP' },
          );
          assert.equal(opened, false);
          assert.equal(entered, false);
          assert.equal((await lstat(path)).isSymbolicLink(), true);
          assert.equal(await readFile(destination, 'utf8'), original);
        } finally {
          restoreFileMocks(context);
          await fixture.close();
        }
      },
    );
}
