// Checks private-log guard cases: replaced or partial journals fail closed, fsync failure keeps
// SDK success, secrets stay out of records and legacy journals are never reclaimed.
import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET, PRIVATE_LOG_LIMITS } from '@gyblos/config';
import {
  PRIVATE_LOG_CODES,
  PRIVATE_LOG_STATES,
} from '@gyblos/runtime/constants';

import {
  createPrivateLog,
  DIAGNOSTIC_CANARY,
  diagnosticDirectory,
  diagnosticRows,
  rm,
  withDiagnosticHost,
} from './support/facilitator-diagnostic-fixture';
import {
  PRIVATE_LOG_PLATFORM_SKIP,
  withLogIo,
} from './support/private-log-fixture';

for (const fault of [
  'symlink-parent',
  'directory-permissions',
  'hardlink',
  'inode-swap',
] as const)
  void test(
    `private log refuses ${fault} without modifying the replacement`,
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async () => {
          const path = join(directory, 'log');
          if (fault === 'symlink-parent') {
            const outside = join(directory, 'outside');
            await mkdir(outside, { mode: 0o700 });
            await symlink(outside, path);
            const log = await createPrivateLog(join(path, 'nested'));
            assert.equal(log.health().code, PRIVATE_LOG_CODES.UNSAFE_PATH);
            assert.deepEqual(await readdir(outside), []);
            await log.close();
            return;
          }
          if (fault === 'directory-permissions') {
            await mkdir(path, { mode: 0o700 });
            await chmod(path, 0o755);
            const log = await createPrivateLog(path);
            assert.equal(log.health().code, PRIVATE_LOG_CODES.UNSAFE_PATH);
            assert.deepEqual(await readdir(path), []);
            await log.close();
            return;
          }
          const log = await createPrivateLog(path);
          const original = log.path!;
          if (fault === 'hardlink') await link(original, join(path, 'alias'));
          else {
            await rename(original, original + '.saved');
            await writeFile(original, 'replacement\n', {
              mode: 0o600,
              flag: 'wx',
            });
          }
          const before = await readFile(original);
          log.write({ synthetic: 'must not be appended' });
          await log.flush();
          assert.equal(log.health().code, PRIVATE_LOG_CODES.UNSAFE_PATH);
          assert.equal(log.health().synced, 0);
          assert.deepEqual(await readFile(original), before);
          if (fault === 'inode-swap')
            assert.equal((await readFile(original + '.saved')).length, 0);
          await log.close();
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
void test(
  'partial append poisons its writer and restart preserves the damaged tail',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async (io) => {
        const log = await createPrivateLog(join(directory, 'log'));
        io.write = async (data, proceed) => {
          await proceed(data.slice(0, 5));
          throw new Error(DIAGNOSTIC_CANARY);
        };
        log.write({ synthetic: 'partial' });
        await log.flush();
        assert.equal(log.health().code, PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
        assert.equal(log.health().synced, 0);
        const damaged = await readFile(log.path!);
        log.write({ synthetic: 'never append behind damaged data' });
        await log.close();
        assert.deepEqual(await readFile(log.path!), damaged);
        io.write = undefined;
        const restarted = await createPrivateLog(join(directory, 'log'));
        restarted.write({ synthetic: 'new file' });
        await restarted.close();
        assert.notEqual(restarted.path, log.path);
        assert.equal((await diagnosticRows(restarted.path!)).length, 1);
        assert.deepEqual(await readFile(log.path!), damaged);
        assert.ok(!io.warnings.join('').includes(DIAGNOSTIC_CANARY));
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'fsync failure keeps SDK success and exposes only canonical degradation',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async (io) => {
        const log = await createPrivateLog(join(directory, 'log'));
        io.sync = async () => {
          throw new Error(DIAGNOSTIC_CANARY);
        };
        await withDiagnosticHost(
          { onDiagnostic: log.write },
          async ({ call, calls }) => {
            const response = await call();
            assert.equal(response.status, 200);
            assert.equal((await response.json()).success, true);
            assert.equal(calls.settle, 1);
          },
        );
        await log.close();
        assert.equal(log.health().state, PRIVATE_LOG_STATES.DEGRADED);
        assert.equal(log.health().code, PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
        assert.equal(log.health().synced, 0);
        assert.equal(io.warnings.length, 1);
        assert.ok(!JSON.stringify(log.health()).includes(DIAGNOSTIC_CANARY));
        assert.ok(!io.warnings.join('').includes(DIAGNOSTIC_CANARY));
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'persistent facilitator logs exclude non-URL secrets from SDK reasons and messages',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      const log = await createPrivateLog(join(directory, 'log'));
      await withDiagnosticHost(
        {
          onDiagnostic: log.write,
          settle: async () => ({
            success: false,
            network: DEVNET,
            transaction: '',
            errorReason: DIAGNOSTIC_CANARY,
            errorMessage: DIAGNOSTIC_CANARY,
          }),
        },
        async ({ call }) => {
          const response = await call();
          assert.equal(response.status, 200);
          await response.json();
        },
      );
      await log.close();
      const bytes = await readFile(log.path!, 'utf8');
      assert.ok(!bytes.includes(DIAGNOSTIC_CANARY));
      assert.ok(!bytes.includes('errorMessage'));
      assert.equal((await diagnosticRows(log.path!)).length, 4);
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'log instance limit never reclaims legacy journals',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async () => {
        for (let index = 0; index < PRIVATE_LOG_LIMITS.maxFiles; index++)
          await writeFile(
            join(
              directory,
              PRIVATE_LOG_LIMITS.filenamePrefix +
                'old-' +
                index +
                PRIVATE_LOG_LIMITS.filenameSuffix,
            ),
            'old\n',
            { mode: 0o600 },
          );
        const before = await readdir(directory);
        const log = await createPrivateLog(directory);
        assert.equal(log.health().code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
        assert.deepEqual(await readdir(directory), before);
        await log.close();
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
