// The real buyer journal records finalized absence and preserves its evidence across replacement.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openBatchBuyerBackend,
  openBatchBuyerPool,
} from '@gyblos/payments-upto/batch-session';

import { batchAbsenceRig } from '../support/batch-absence';

for (const pooled of [false, true]) {
  void test(`a proved absent deposit can be replaced for the same seller (pool = ${pooled})`, async (t) => {
    const rig = await batchAbsenceRig(t);
    const { options, financial } = rig;
    const backend = openBatchBuyerBackend({
      ...options,
      paths: options.paths.legacy,
      payer: { ...financial.vm.payer, ...options.payer },
    });
    const buyer = await backend.create(financial.terms);
    const signal = new AbortController().signal;
    const recovery = buyer.openingRecovery!;
    assert.equal(await recovery.claim(), true);
    assert.equal(await recovery.status(signal), 'unknown');
    financial.vm.expire();
    assert.equal(await recovery.status(signal), 'absent');
    const id = buyer.snapshot().channelId;
    await buyer.dispose();
    const next = {
      ...financial.terms,
      expiresAt: financial.terms.expiresAt + 1000,
    };
    if (pooled) {
      const pool = await openBatchBuyerPool({
        paths: options.paths,
        totalDepositAtomic: next.depositAtomic,
        now: options.now,
        backend: async () => backend,
      });
      try {
        await pool.resolve(next.sellerNodeId);
        assert.equal((await pool.budget()).committedAtomic, '0');
        const entry = await pool.allocate(next);
        assert.equal(entry.stored?.snapshot.channelId, '');
        assert.equal((await pool.budget()).availableAtomic, '0');
      } finally {
        await pool.dispose();
      }
    } else {
      await backend.renew!(id, next, next.depositAtomic);
    }
    const restored = await backend.inspect();
    assert.deepEqual(restored?.terms, next);
    assert.equal(restored?.snapshot.channelId, '');
    assert.equal(rig.signs(), 0);
    assert.equal(financial.vm.sends(), 0);
  });
}
