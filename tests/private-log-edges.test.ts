// Checks private-log edge cases: canonical storage error codes, atomic slot reservation, bounded
// close and refusal of undefined serialization.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import { PRIVATE_LOG_CODES } from '@gyblos/runtime/constants';
import { PrivateLogError } from '@gyblos/runtime/private-log-file';

import {
  createPrivateLog,
  DIAGNOSTIC_CANARY,
  diagnosticBarrier,
  diagnosticDirectory,
  diagnosticUntil,
  rm,
} from './support/facilitator-diagnostic-fixture.js';
import {
  PRIVATE_LOG_PLATFORM_SKIP,
  withLogIo,
} from './support/private-log-fixture.js';

for (const hostile of [false, true])
  void test(
    `storage errors retain only canonical codes: hostile=${hostile}`,
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        await withLogIo(async (io) => {
          const error = new PrivateLogError(PRIVATE_LOG_CODES.UNSAFE_PATH);
          let reads = 0;
          Object.defineProperty(error, 'code', {
            get() {
              reads++;
              return DIAGNOSTIC_CANARY;
            },
          });
          io.openError = hostile
            ? new Proxy(error, {
                getPrototypeOf() {
                  throw new Error(DIAGNOSTIC_CANARY);
                },
              })
            : error;
          const log = await createPrivateLog(directory);
          assert.equal(log.health().code, PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
          assert.ok(
            reads <= 2,
            'At most the Node errno guard and canonical projector may inspect the code',
          );
          assert.ok(!JSON.stringify(log.health()).includes(DIAGNOSTIC_CANARY));
          await log.close();
          assert.ok(!io.warnings.join('').includes(DIAGNOSTIC_CANARY));
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
void test(
  'concurrent journal creation reserves the last remaining slot atomically',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async (io) => {
        for (let index = 0; index < PRIVATE_LOG_LIMITS.maxFiles - 1; index++)
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
        const barrier = diagnosticBarrier<void>();
        let opens = 0;
        io.beforeFileOpen = async () => {
          if (++opens === 2) barrier.resolve();
          await barrier.promise;
        };
        const logs = await Promise.all([
          createPrivateLog(directory),
          createPrivateLog(directory),
        ]);
        try {
          assert.equal(
            (await readdir(directory)).length,
            PRIVATE_LOG_LIMITS.maxFiles,
          );
          assert.equal(
            logs.filter(
              (log) => log.health().code === PRIVATE_LOG_CODES.STORAGE_LIMIT,
            ).length,
            1,
          );
        } finally {
          await Promise.all(logs.map((log) => log.close()));
        }
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'mixed legacy and out-of-pool slots cannot expose excess concurrent capacity',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async () => {
        const preserved = [
          'legacy',
          ...Array.from(
            { length: PRIVATE_LOG_LIMITS.maxFiles - 3 },
            (_, index) => index,
          ),
          PRIVATE_LOG_LIMITS.maxFiles - 1,
        ];
        for (const index of preserved)
          await writeFile(
            join(
              directory,
              PRIVATE_LOG_LIMITS.filenamePrefix +
                index +
                PRIVATE_LOG_LIMITS.filenameSuffix,
            ),
            'old\n',
            { mode: 0o600 },
          );
        const logs = await Promise.all([
          createPrivateLog(directory),
          createPrivateLog(directory),
        ]);
        try {
          assert.ok(
            logs.every(
              (log) => log.health().code === PRIVATE_LOG_CODES.STORAGE_LIMIT,
            ),
          );
          assert.equal((await readdir(directory)).length, preserved.length);
          for (const index of preserved)
            assert.equal(
              await readFile(
                join(
                  directory,
                  PRIVATE_LOG_LIMITS.filenamePrefix +
                    index +
                    PRIVATE_LOG_LIMITS.filenameSuffix,
                ),
                'utf8',
              ),
              'old\n',
            );
        } finally {
          await Promise.all(logs.map((log) => log.close()));
        }
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'bounded close includes descriptor retirement and reports pending cleanup truthfully',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async (io) => {
        const log = await createPrivateLog(directory, { drainMs: 20 });
        const release = diagnosticBarrier<void>();
        io.close = async () => {
          await release.promise;
        };
        const closing = log.close();
        try {
          assert.equal(
            await Promise.race([
              closing.then(() => true),
              setTimeout(100, false),
            ]),
            true,
          );
          assert.equal(log.health().code, PRIVATE_LOG_CODES.DRAIN_TIMEOUT);
          assert.equal(log.health().closed, false);
        } finally {
          release.resolve();
          await closing;
        }
        await diagnosticUntil(() => log.health().closed);
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
void test(
  'undefined serialization is refused before it can poison JSONL',
  { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
  async () => {
    const directory = await diagnosticDirectory();
    try {
      await withLogIo(async () => {
        const log = await createPrivateLog(directory);
        try {
          log.write({
            toJSON() {
              return undefined;
            },
          });
          await log.flush();
          assert.equal(log.health().synced, 0);
          assert.equal(log.health().code, PRIVATE_LOG_CODES.PERSISTENCE_FAILED);
          assert.equal(await readFile(log.path!, 'utf8'), '');
        } finally {
          await log.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);
