// Reproduces guarded receipt reads racing valid atomic replacement; only synthetic private temporary files.
import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FILE_MODES, receiptPathsIn } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { listReceipts, openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { receiptChannelFixture } from '../support/receipt-channel';
import { observeReceipt } from '../support/receipt-observation';

void test('receipt observation waits for work completion before reading a concurrently replaced valid snapshot', async () => {
  const fixture = await receiptChannelFixture();
  const root = await filesystem.mkdtemp(
    join(await filesystem.realpath(tmpdir()), 'gyblos-receipt-observation-'),
  );
  const options = {
    environment: { GYBLOS_HOME: root },
    role: P2P_ROLES.SELLER,
    nodeId: fixture.seller.nodeId,
    now: () => 1700000000100,
  };
  const originalOpen = filesystem.open;
  let active = true;
  let saved = 0;
  let reads = 0;
  let waitChecks = 0;
  try {
    const store = openReceiptStore(options);
    await store.put(fixture.envelope);
    assert.equal(
      await store.confirm(
        fixture.confirm.params.receipt,
        new AbortController().signal,
      ),
      true,
    );
    const path = receiptPathsIn(options.environment, options.role).state;
    const replacement = path + '.pending-snapshot';
    const bytes = await filesystem.readFile(path);
    await filesystem.writeFile(replacement, bytes, {
      mode: FILE_MODES.privateFile,
    });
    filesystem.open = async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args);
      if (String(args[0]) === path) {
        reads++;
        if (active) await filesystem.rename(replacement, path);
      }
      return file;
    };
    syncBuiltinESMExports();
    const found = await observeReceipt(
      {
        health: () => ({ active, saved, failed: 0, dropped: 0 }),
        read: (signal) => listReceipts(options, signal),
        wait: async (ready) => {
          assert.equal(ready(), false);
          waitChecks++;
          assert.equal(reads, 0);
          saved++;
          assert.equal(
            ready(),
            false,
            'saved is not enough while work remains active',
          );
          await filesystem.rename(replacement, path);
          active = false;
          assert.equal(ready(), true);
        },
      },
      { active: false, saved: 0, failed: 0, dropped: 0 },
      new AbortController().signal,
    );
    assert.equal(waitChecks, 1);
    assert.equal(reads, 1);
    assert.equal(found.length, 1);
    const [entry] = found;
    assert.ok(entry);
    assert.deepEqual(entry.receipt, fixture.confirm.params.receipt);
    assert.deepEqual(await filesystem.readFile(path), bytes);
  } finally {
    filesystem.open = originalOpen;
    syncBuiltinESMExports();
    await filesystem.rm(root, { recursive: true, force: true });
  }
});
void test('receipt observation refuses failed or dropped work before opening storage', async () => {
  for (const changed of [
    { failed: 1, dropped: 0 },
    { failed: 0, dropped: 1 },
  ]) {
    let reads = 0;
    await assert.rejects(
      observeReceipt(
        {
          health: () => ({ active: false, saved: 0, ...changed }),
          read: async () => {
            reads++;
            return [];
          },
          wait: async (ready) => {
            ready();
          },
        },
        { active: false, saved: 0, failed: 0, dropped: 0 },
        new AbortController().signal,
      ),
      { code: 'ERR_ASSERTION' },
    );
    assert.equal(reads, 0);
  }
});
void test('receipt observation propagates fail-closed storage errors after settlement', async () => {
  const failure = new NodeError(NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE);
  await assert.rejects(
    observeReceipt(
      {
        health: () => ({ active: false, saved: 1, failed: 0, dropped: 0 }),
        read: async () => {
          throw failure;
        },
        wait: async (ready) => {
          assert.equal(ready(), true);
        },
      },
      { active: false, saved: 0, failed: 0, dropped: 0 },
      new AbortController().signal,
    ),
    (error: unknown) => error === failure,
  );
});
void test('receipt observation cancellation prevents both waiting and late snapshot publication', async () => {
  const before = { active: false, saved: 0, failed: 0, dropped: 0 };
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  let waits = 0;
  await assert.rejects(
    observeReceipt(
      {
        health: () => ({ ...before, saved: 1 }),
        read: async () => {
          reads++;
          return [];
        },
        wait: async () => {
          waits++;
        },
      },
      before,
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(reads, 0);
  assert.equal(waits, 0);
  const during = new AbortController();
  await assert.rejects(
    observeReceipt(
      {
        health: () => ({ ...before, active: true }),
        read: async () => {
          reads++;
          return [];
        },
        wait: async (ready) => {
          assert.equal(ready(), false);
          during.abort();
        },
      },
      before,
      during.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(reads, 0);
  const late = new AbortController();
  await assert.rejects(
    observeReceipt(
      {
        health: () => ({ ...before, saved: 1 }),
        read: async () => {
          late.abort();
          return [];
        },
        wait: async (ready) => {
          assert.equal(ready(), true);
        },
      },
      before,
      late.signal,
    ),
    { name: 'AbortError' },
  );
});

void test('receipt observation preserves the existing wait deadline without opening snapshots', async () => {
  const deadline = new Error('Synthetic existing receipt deadline');
  let reads = 0;
  await assert.rejects(
    observeReceipt(
      {
        health: () => ({ active: true, saved: 0, failed: 0, dropped: 0 }),
        read: async () => {
          reads++;
          return [];
        },
        wait: async (ready) => {
          assert.equal(ready(), false);
          throw deadline;
        },
      },
      { active: false, saved: 0, failed: 0, dropped: 0 },
      new AbortController().signal,
    ),
    (error: unknown) => error === deadline,
  );
  assert.equal(reads, 0);
});
