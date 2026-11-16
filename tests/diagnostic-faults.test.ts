// Fault injection at public diagnostic entries: metadata and stalled storage never control the caller.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import {
  createDiagnosticLog,
  createDiagnostics,
} from '@gyblos/runtime/diagnostics';

const CATALOG = {
  component: 'synthetic',
  operation: 'request',
  phases: ['execute'],
  codes: ['FAILED'],
} as const;
void test('metadata generation failure cannot escape diagnostic startup', () => {
  const original = crypto.randomUUID;
  try {
    crypto.randomUUID = () => {
      throw new Error('synthetic entropy failure');
    };
    syncBuiltinESMExports();
    const channel = createDiagnostics({ ...CATALOG, sink: () => {} });
    assert.doesNotThrow(() =>
      channel
        .start()
        .report({ phase: CATALOG.phases[0], code: CATALOG.codes[0] }),
    );
    assert.equal(channel.health().dropped, 1);
    assert.doesNotThrow(() => createDiagnostics(CATALOG).start());
  } finally {
    crypto.randomUUID = original;
    syncBuiltinESMExports();
  }
});
void test(
  'close budget includes a stalled lazy open and closes the file after a late open',
  { timeout: 10000 },
  async () => {
    const root = await fs.mkdtemp(
      join(await fs.realpath(tmpdir()), 'gyb-diagnostic-open-'),
    );
    const directory = join(root, 'diagnostics');
    const original = fs.open;
    let openedFiles = 0;
    let closedFiles = 0;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === directory) {
        entered();
        await gate;
      }
      const handle = await original(...args);
      if (
        typeof args[0] === 'string' &&
        args[0].startsWith(directory) &&
        args[0].endsWith('.jsonl')
      ) {
        openedFiles++;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closedFiles++;
          return close();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const log = createDiagnosticLog(directory);
    const channel = createDiagnostics({ ...CATALOG, sink: log.write });
    try {
      channel
        .start()
        .report({ phase: CATALOG.phases[0], code: CATALOG.codes[0] });
      await blocked;
      const closed = log.close();
      const deadline = new AbortController();
      try {
        assert.equal(
          await Promise.race([
            closed.then(() => true),
            delay(PRIVATE_LOG_LIMITS.drainMs * 2, false, {
              signal: deadline.signal,
            }),
          ]),
          true,
        );
      } finally {
        deadline.abort();
      }
      assert.equal(log.health().failed, true);
      assert.equal(log.health().dropped, 1);
    } finally {
      release();
      fs.open = original;
      syncBuiltinESMExports();
      await log.close();
      // flush joins any late open/close through the same bounded lifecycle.
      await log.flush();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
