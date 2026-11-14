// Persistence/cancellation boundaries preserve original absence evidence and never invent financial movement.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { batchPoolChannelPaths } from '@gyblos/config/home';
import {
  openBatchBuyerPool,
  recoverBatchBuyer,
  recoverBatchPool,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchAbsenceRig } from '../support/batch-absence';

for (const catalog of [false, true]) {
  void test(`never-created recovery resumes after a failed ${catalog ? 'catalog' : 'child proof'} write`, async (t) => {
    const rig = await batchAbsenceRig(t);
    rig.financial.vm.expire();
    const rename = fs.rename;
    let fail = true;
    t.mock.method(
      fs,
      'rename',
      async (...args: Parameters<typeof fs.rename>) => {
        if (
          fail &&
          String(args[1]) ===
            (catalog ? rig.options.paths.state : rig.options.paths.legacy.state)
        )
          throw new Error('Synthetic persistence failure');
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const first = await rig.recover();
    assert.equal(first[0]?.confirmed, false);
    assert.equal(first[0]?.settlement, null);
    const child = await rig.read();
    assert.equal(
      Object.keys(child.pending).some((key) => key.endsWith(':absent')),
      catalog,
    );
    if (!catalog)
      assert.deepEqual(await rig.budget(), {
        committedAtomic: '1000',
        availableAtomic: '0',
      });
    fail = false;
    const next = await rig.recover();
    assert.equal(next[0]?.notCreated, true);
    assert.deepEqual(await rig.budget(), {
      committedAtomic: '0',
      availableAtomic: '1000',
    });
    assert.equal(rig.signs(), 0);
    assert.equal(rig.financial.vm.sends(), 0);
  });
}
void test('cancelled absence observation changes no child or catalog state', async (t) => {
  const rig = await batchAbsenceRig(t);
  rig.financial.vm.expire();
  const abort = new AbortController();
  const base = rig.options.rpc;
  rig.patch({
    getAccountInfo: (...args: Parameters<typeof base.getAccountInfo>) => ({
      send: async () => {
        const value = await base.getAccountInfo(...args).send();
        abort.abort();
        return value;
      },
    }),
  });
  const before = await readFile(rig.options.paths.legacy.state);
  const results = await recoverBatchPool({
    ...rig.options,
    signal: abort.signal,
  });
  assert.equal(results[0]?.confirmed, false);
  assert.deepEqual(await readFile(rig.options.paths.legacy.state), before);
  assert.deepEqual(await rig.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
  assert.equal(rig.signs(), 0);
  assert.equal(rig.financial.vm.sends(), 0);
});
void test('competing recovery cannot release the same reservation twice', async (t) => {
  const rig = await batchAbsenceRig(t);
  rig.financial.vm.expire();
  const results = await Promise.allSettled([rig.recover(), rig.recover()]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  );
  assert.deepEqual(await rig.budget(), {
    committedAtomic: '0',
    availableAtomic: '1000',
  });
  assert.equal(rig.signs(), 0);
  assert.equal(rig.financial.vm.sends(), 0);
});
void test('releasing an unfunded opening preserves a different seller reservation and refuses its original slot', async (t) => {
  const rig = await batchAbsenceRig(t);
  rig.financial.vm.expire();
  await rig.recover();
  const options = {
    paths: rig.options.paths,
    totalDepositAtomic: '1000',
    now: rig.options.now,
    backend: async () => assert.fail('No replacement backend'),
  };
  const pool = await openBatchBuyerPool(options);
  try {
    await assert.rejects(
      pool.begin(rig.financial.terms.sellerNodeId, '11'.repeat(16)),
      { code: SESSION_CODES.CLOSED },
    );
    await pool.allocate({
      ...rig.financial.terms,
      sellerNodeId: '56'.repeat(32),
    });
    assert.deepEqual(await pool.budget(), {
      committedAtomic: '1000',
      availableAtomic: '0',
    });
    const entries = await pool.list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.refundedAtomic, '0');
    assert.equal(entries[1]!.refundedAtomic, '0');
  } finally {
    await pool.dispose();
  }
  const secondPaths = batchPoolChannelPaths(rig.options.paths, '56'.repeat(32));
  const firstAgain = await recoverBatchBuyer({
    ...rig.options,
    paths: rig.options.paths.legacy,
  });
  assert.equal(firstAgain?.notCreated, true);
  assert.equal(
    JSON.parse(await readFile(secondPaths.state, 'utf8')).hints,
    null,
  );
  const restored = await openBatchBuyerPool(options);
  try {
    assert.deepEqual(await restored.budget(), {
      committedAtomic: '1000',
      availableAtomic: '0',
    });
  } finally {
    await restored.dispose();
  }
});
