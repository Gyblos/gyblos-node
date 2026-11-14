// Cooperating catalog readers and publishers preserve private file checks and committed budget.
import assert from 'node:assert/strict';
import filesystem, { realpath, rename } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  inspectBatchPool,
  inspectBatchSession,
  openBatchBuyerPool,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { sessionRig } from './support/batch-session';
import { within } from './support/test-deadline';

async function fixture(t: TestContext) {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const pool = await openBatchBuyerPool({
    paths,
    totalDepositAtomic: '2000',
    now: rig.now,
    backend: async () =>
      assert.fail('Inspection must not construct a financial backend.'),
  });
  t.after(pool.dispose);
  await pool.allocate(rig.terms);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { rig, paths, pool };
}

function heldPublication(
  t: TestContext,
  paths: ReturnType<typeof batchPoolPathsIn>,
  alias: ReturnType<typeof batchPoolPathsIn>,
) {
  const entered = batchDeferred<void>();
  const checked = batchDeferred<void>();
  const release = batchDeferred<void>();
  const nativeRename = filesystem.rename;
  const nativeLstat = filesystem.lstat;
  const nativeOpen = filesystem.open;
  let publishing = false;
  t.mock.method(
    filesystem,
    'rename',
    async (...args: Parameters<typeof rename>) => {
      if (args[1] !== paths.state) return nativeRename(...args);
      publishing = true;
      entered.resolve();
      await release.promise;
      try {
        return await nativeRename(...args);
      } finally {
        publishing = false;
      }
    },
  );
  t.mock.method(
    filesystem,
    'lstat',
    async (...args: Parameters<typeof filesystem.lstat>) => {
      const info = await nativeLstat(...args);
      if (publishing && args[0] === alias.directory) checked.resolve();
      return info;
    },
  );
  t.mock.method(
    filesystem,
    'open',
    (...args: Parameters<typeof filesystem.open>) => {
      if (args[0] === paths.state || args[0] === alias.state)
        assert.equal(
          publishing,
          false,
          'An inspector must not enter an owned catalog publication.',
        );
      return nativeOpen(...args);
    },
  );
  syncBuiltinESMExports();
  return {
    entered: entered.promise,
    checked: checked.promise,
    release: () => release.resolve(),
  };
}

void test('catalog inspection waits for an owned atomic publication and returns its committed request', async (t) => {
  const { rig, paths, pool } = await fixture(t);
  const alias = {
    ...paths,
    directory: await realpath(paths.directory),
    state: await realpath(paths.state),
  };
  const gate = heldPublication(t, paths, alias);
  const requestId = '01'.repeat(16);
  const writing = pool.begin(rig.terms.sellerNodeId, requestId);
  void writing.catch(() => undefined);
  let reading: ReturnType<typeof inspectBatchPool> | undefined;
  try {
    await within(gate.entered);
    reading = inspectBatchPool(alias);
    void reading.catch(() => undefined);
    await within(gate.checked);
    // Finish the common directory-validation continuations before checking publication exclusion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await within(inspectBatchSession(rig.sellerOptions.paths));
    gate.release();
    await within(writing);
    const entries = await within(reading);
    assert.equal(entries[0]?.requestId, requestId);
    assert.equal(entries[0]?.uncertain, true);
    assert.equal(entries[0]?.refundedAtomic, '0');
    assert.deepEqual(await pool.budget(), {
      committedAtomic: '1000',
      availableAtomic: '1000',
    });
    assert.deepEqual(rig.calls, []);
  } finally {
    gate.release();
    await Promise.allSettled([writing, reading]);
  }
});

function heldReaders(
  t: TestContext,
  paths: ReturnType<typeof batchPoolPathsIn>,
) {
  const entered = batchDeferred<void>();
  const admitted = batchDeferred<void>();
  const release = batchDeferred<void>();
  const nativeOpen = filesystem.open;
  const nativeLstat = filesystem.lstat;
  const nativeRename = filesystem.rename;
  let held = false;
  let checked = 0;
  let publications = 0;
  t.mock.method(
    filesystem,
    'open',
    async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await nativeOpen(...args);
      if (!held && args[0] === paths.state) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return handle;
    },
  );
  t.mock.method(
    filesystem,
    'lstat',
    async (...args: Parameters<typeof filesystem.lstat>) => {
      const info = await nativeLstat(...args);
      if (
        args[0] === paths.directory &&
        ++checked === BATCH_SESSION_DEFAULTS.maxPendingOperations
      )
        admitted.resolve();
      return info;
    },
  );
  t.mock.method(filesystem, 'rename', (...args: Parameters<typeof rename>) => {
    if (args[1] === paths.state) publications++;
    return nativeRename(...args);
  });
  syncBuiltinESMExports();
  return {
    entered: entered.promise,
    admitted: admitted.promise,
    release: () => release.resolve(),
    publications: () => publications,
  };
}

void test('catalog read pressure refuses publication before I/O without poisoning its budget authority', async (t) => {
  const { rig, paths, pool } = await fixture(t);
  const gate = heldReaders(t, paths);
  const first = inspectBatchPool(paths);
  void first.catch(() => undefined);
  let readings = Promise.all([first]);
  try {
    await within(gate.entered);
    readings = Promise.all([
      first,
      ...Array.from(
        { length: BATCH_SESSION_DEFAULTS.maxPendingOperations - 1 },
        () => inspectBatchPool(paths),
      ),
    ]);
    void readings.catch(() => undefined);
    await within(gate.admitted);
    // The last directory check has finished; drain its promise continuations before testing queue capacity.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      within(pool.begin(rig.terms.sellerNodeId, '01'.repeat(16))),
      { code: SESSION_CODES.BUSY },
    );
    assert.equal(gate.publications(), 0);
  } finally {
    gate.release();
    await within(readings);
  }
  assert.equal((await inspectBatchPool(paths))[0]?.requestId, null);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '1000',
    availableAtomic: '1000',
  });
  await pool.begin(rig.terms.sellerNodeId, '02'.repeat(16));
  assert.equal((await inspectBatchPool(paths))[0]?.requestId, '02'.repeat(16));
  assert.deepEqual(rig.calls, []);
});

void test('an actual catalog publication failure still poisons its handle without inventing budget credit', async (t) => {
  const { rig, paths, pool } = await fixture(t);
  const nativeRename = filesystem.rename;
  let attempts = 0;
  t.mock.method(filesystem, 'rename', (...args: Parameters<typeof rename>) => {
    if (args[1] === paths.state && ++attempts === 1)
      return Promise.reject(new Error('Synthetic catalog publication failure'));
    return nativeRename(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(pool.begin(rig.terms.sellerNodeId, '01'.repeat(16)), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  await assert.rejects(pool.begin(rig.terms.sellerNodeId, '02'.repeat(16)), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  await assert.rejects(pool.budget(), { code: SESSION_CODES.UNAVAILABLE });
  assert.equal(attempts, 1);
  const entries = await inspectBatchPool(paths);
  assert.equal(entries[0]?.requestId, null);
  assert.equal(entries[0]?.refundedAtomic, '0');
  assert.deepEqual(rig.calls, []);
});
