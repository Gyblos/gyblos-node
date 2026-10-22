// Owns offline private log cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  PRIVATE_LOG_CODES,
  PRIVATE_LOG_STATES,
} from '@gyblos/runtime/constants';

import {
  createPrivateLog,
  DIAGNOSTIC_CANARY,
  diagnosticBarrier,
  diagnosticDirectory,
  diagnosticRows,
  diagnosticUntil,
  rm,
  withDiagnosticHost,
} from './facilitator-diagnostic-fixture.js';
import { PRIVATE_LOG_PLATFORM_SKIP, withLogIo } from './private-log-fixture.js';

export function registerPrivateLogCases() {
  void test(
    'facilitator records survive stop and restart in distinct private exclusive files',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async (io) => {
          const log = await createPrivateLog(join(directory, 'log'));
          await withDiagnosticHost(
            { onDiagnostic: log.write },
            async ({ call }) => {
              const response = await call();
              assert.equal(response.status, 200);
              await response.json();
            },
          );
          const health = await log.close();
          assert.equal(health.state, PRIVATE_LOG_STATES.CLOSED);
          assert.equal(health.synced, 4);
          const firstBytes = await readFile(log.path!);
          const firstRows = await diagnosticRows(log.path!);
          assert.equal(firstRows.length, 4);
          const restarted = await createPrivateLog(join(directory, 'log'));
          restarted.write({ synthetic: 'next instance' });
          await restarted.close();
          assert.notEqual(restarted.path, log.path);
          assert.deepEqual(await readFile(log.path!), firstBytes);
          assert.equal((await diagnosticRows(restarted.path!)).length, 1);
          assert.equal((await lstat(log.path!)).mode & 0o777, 0o600);
          assert.equal(
            (await lstat(join(directory, 'log'))).mode & 0o777,
            0o700,
          );
          assert.ok(io.directorySyncs >= 2);
          for (const flags of io.fileFlags) {
            assert.ok(flags & constants.O_EXCL);
            assert.ok(flags & constants.O_NOFOLLOW);
            assert.ok(flags & constants.O_NONBLOCK);
          }
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  void test(
    'stalled fsync cannot block facilitator response; queue and shutdown are bounded',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async (io) => {
          const log = await createPrivateLog(join(directory, 'log'), {
            pendingRecords: 2,
            drainMs: 25,
          });
          const reached = diagnosticBarrier<void>();
          const release = diagnosticBarrier<void>();
          io.sync = async () => {
            reached.resolve();
            await release.promise;
          };
          try {
            await withDiagnosticHost(
              { onDiagnostic: log.write },
              async ({ call, calls }) => {
                const response = await call();
                assert.equal(response.status, 200);
                await response.json();
                assert.equal(calls.settle, 1);
                await reached.promise;
                assert.equal(log.health().queued, 2);
                assert.equal(log.health().code, PRIVATE_LOG_CODES.QUEUE_FULL);
                const health = await log.close();
                assert.equal(health.code, PRIVATE_LOG_CODES.DRAIN_TIMEOUT);
                assert.equal(health.synced, 0);
                assert.equal(health.closed, false);
              },
            );
          } finally {
            release.resolve();
          }
          await diagnosticUntil(() => log.health().closed);
          assert.equal(log.health().synced, 2);
          assert.equal(log.health().queued, 0);
          assert.equal(io.warnings.length, 1);
          assert.ok(!io.warnings.join('').includes(DIAGNOSTIC_CANARY));
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  void test(
    'open failure degrades diagnostics without changing the SDK payment response',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async (io) => {
          io.openError = new Error(DIAGNOSTIC_CANARY);
          const log = await createPrivateLog(join(directory, 'log'));
          await withDiagnosticHost(
            { onDiagnostic: log.write },
            async ({ call, calls }) => {
              const response = await call();
              assert.equal(response.status, 200);
              await response.json();
              assert.equal(calls.settle, 1);
            },
          );
          const health = await log.close();
          assert.equal(health.state, PRIVATE_LOG_STATES.DEGRADED);
          assert.equal(health.code, PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
          assert.equal(health.synced, 0);
          assert.ok(health.dropped >= 4);
          assert.ok(!io.warnings.join('').includes(DIAGNOSTIC_CANARY));
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  void test(
    'record and byte limits preserve existing records without truncation',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async () => {
          const log = await createPrivateLog(join(directory, 'log'), {
            recordBytes: 32,
            fileBytes: 40,
            maxRotations: 0,
          });
          log.write({ small: 1 });
          await log.flush();
          const before = await readFile(log.path!);
          log.write({ large: 'x'.repeat(100) });
          assert.equal(log.health().code, PRIVATE_LOG_CODES.RECORD_LIMIT);
          log.write({ small: '1234567890123456789012345' });
          assert.equal(log.health().code, PRIVATE_LOG_CODES.RECORD_LIMIT);
          log.write({ small: 2 });
          log.write({ small: 3 });
          log.write({ small: 4 });
          await log.flush();
          assert.equal(log.health().code, PRIVATE_LOG_CODES.STORAGE_LIMIT);
          assert.equal(log.health().synced, 3);
          assert.ok(
            (await readFile(log.path!))
              .subarray(0, before.length)
              .equals(before),
          );
          await log.close();
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  void test(
    'exclusive concurrent writers never interleave or reuse another journal',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        const logs = await Promise.all([
          createPrivateLog(join(directory, 'log')),
          createPrivateLog(join(directory, 'log')),
        ]);
        for (let index = 0; index < 20; index++)
          for (const [writer, log] of logs.entries())
            log.write({ writer, index });
        await Promise.all(logs.map((log) => log.close()));
        assert.notEqual(logs[0]!.path, logs[1]!.path);
        for (const [writer, log] of logs.entries()) {
          const rows = JSON.parse(
            '[' +
              (await readFile(log.path!, 'utf8')).trim().split('\n').join(',') +
              ']',
          ) as { writer: number; index: number }[];
          assert.equal(rows.length, 20);
          assert.ok(rows.every((row) => row.writer === writer));
          assert.deepEqual(
            rows.map((row) => row.index),
            Array.from({ length: 20 }, (_, index) => index),
          );
        }
        assert.equal((await readdir(join(directory, 'log'))).length, 2);
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
}
