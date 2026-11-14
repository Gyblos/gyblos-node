// Concurrent inspection waits for a legitimate journal publication without relaxing file guards.
import assert from 'node:assert/strict';
import filesystem, { chmod, realpath, rename } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { sessionRig } from './support/batch-session';
import { within } from './support/test-deadline';

void test('session inspection waits for an owned atomic publication and reads the committed request', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const paths = rig.buyerOptions.paths;
  const target = await realpath(paths.state);
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  const nativeRename = filesystem.rename;
  const nativeLstat = filesystem.lstat;
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
    (...args: Parameters<typeof filesystem.lstat>) => {
      if (args[0] === paths.state || args[0] === target)
        assert.equal(
          publishing,
          false,
          'an inspector must not enter an owned journal publication',
        );
      return nativeLstat(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.after(() => release.resolve());
  const writing = rig.buyer.begin(rig.request(1));
  const observedWrite = writing.catch(() => undefined);
  try {
    await within(entered.promise);
    const reading = inspectBatchSession({
      ...paths,
      directory: await realpath(paths.directory),
      state: target,
    });
    const observedRead = reading.catch(() => undefined);
    try {
      // An unrelated journal completes while this one is held: coordination must be per file.
      await within(inspectBatchSession(rig.sellerOptions.paths));
      release.resolve();
      await within(writing);
      const snapshot = await within(reading);
      assert.ok(snapshot);
      assert.equal(snapshot.pending, true);
      assert.equal(snapshot.snapshot.reservedAtomic, '200');
      assert.equal(snapshot.snapshot.channelId, rig.buyer.snapshot().channelId);
      assert.equal(snapshot.snapshot.cumulativeAtomic, '0');
      assert.deepEqual(rig.calls, ['deposit']);
    } finally {
      release.resolve();
      await observedRead;
    }
  } finally {
    release.resolve();
    await observedWrite;
  }
});

void test('session inspection still refuses a journal whose private mode is changed', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const path = rig.buyerOptions.paths.state;
  await chmod(path, 0o644);
  t.after(() => chmod(path, FILE_MODES.privateFile));
  await assert.rejects(inspectBatchSession(rig.buyerOptions.paths), {
    code: SESSION_CODES.UNAVAILABLE,
  });
});

void test('read admission pressure does not poison a journal when no publication was attempted', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  const nativeOpen = filesystem.open;
  const nativeRename = filesystem.rename;
  let held = false;
  let publications = 0;
  t.mock.method(
    filesystem,
    'open',
    async (...args: Parameters<typeof filesystem.open>) => {
      const file = await nativeOpen(...args);
      if (!held && args[0] === rig.buyerOptions.paths.state) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return file;
    },
  );
  t.mock.method(filesystem, 'rename', (...args: Parameters<typeof rename>) => {
    if (args[1] === rig.buyerOptions.paths.state) publications++;
    return nativeRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.after(() => release.resolve());
  const first = inspectBatchSession(rig.buyerOptions.paths);
  await within(entered.promise);
  const queued = Array.from(
    { length: BATCH_SESSION_DEFAULTS.maxPendingOperations - 1 },
    () => inspectBatchSession(rig.buyerOptions.paths),
  );
  const readings = Promise.all([first, ...queued]);
  let refused: unknown;
  try {
    try {
      await rig.buyer.begin(rig.request(1));
    } catch (error) {
      refused = error;
    }
    assert.ok(refused instanceof PaymentSessionError);
    assert.equal(publications, 0);
  } finally {
    release.resolve();
    await within(readings);
  }
  assert.equal(
    (await inspectBatchSession(rig.buyerOptions.paths))?.snapshot
      .reservedAtomic,
    '0',
  );
  await assert.doesNotReject(rig.buyer.begin(rig.request(2)));
  assert.equal(refused.code, SESSION_CODES.BUSY);
  assert.equal(
    (await inspectBatchSession(rig.buyerOptions.paths))?.snapshot
      .reservedAtomic,
    '200',
  );
  assert.deepEqual(rig.calls, ['deposit']);
});

void test('an actual publication failure still poisons the writer and preserves the old journal', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const nativeRename = filesystem.rename;
  let attempts = 0;
  t.mock.method(filesystem, 'rename', (...args: Parameters<typeof rename>) => {
    if (args[1] === rig.buyerOptions.paths.state) {
      attempts++;
      if (attempts === 1)
        return Promise.reject(new Error('Synthetic publication failure'));
    }
    return nativeRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(rig.buyer.begin(rig.request(1)), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  await assert.rejects(rig.buyer.begin(rig.request(2)), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  assert.equal(attempts, 1);
  assert.equal(
    (await inspectBatchSession(rig.buyerOptions.paths))?.snapshot
      .reservedAtomic,
    '0',
  );
  assert.deepEqual(rig.calls, ['deposit']);
});
