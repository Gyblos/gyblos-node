// Shared deposit authority is persistent, private and conservative; all keys and records are synthetic.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { batchPoolPathsIn } from '@gyblos/config/home';
import { openBatchBuyerPool } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

void test('pool persists two seller allocations, reuses A, and refuses an over-budget third seller before backend creation', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  let constructed = 0;
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const options = { paths, totalDepositAtomic: '2000', now: rig.now, backend: async () => { constructed++; throw new Error('No financial construction required'); } };
  let pool = await openBatchBuyerPool(options);
  t.after(() => pool.dispose());
  const a = await pool.allocate(rig.terms);
  const b = await pool.allocate({ ...rig.terms, sellerNodeId: '56'.repeat(32) });
  assert.deepEqual(await pool.allocate(rig.terms), a);
  assert.notEqual(a.terms.sellerNodeId, b.terms.sellerNodeId);
  assert.deepEqual(await pool.budget(), { committedAtomic: '2000', availableAtomic: '0' });
  await assert.rejects(pool.allocate({ ...rig.terms, sellerNodeId: '78'.repeat(32) }), { code: SESSION_CODES.LIMIT });
  assert.equal(constructed, 0);
  await pool.dispose();
  pool = await openBatchBuyerPool(options);
  assert.equal((await pool.list()).length, 2);
  assert.deepEqual(await pool.budget(), { committedAtomic: '2000', availableAtomic: '0' });
});
