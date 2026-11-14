// Checks real pooled batch recovery and financial credit; no seller remains running during recovery.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import {
  openBatchBuyerBackend,
  openBatchBuyerPool,
  openBatchSellerBackend,
  recoverBatchPool,
} from '@gyblos/payments-upto/batch-session';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';

import { batchRecoveryRig } from '../support/batch-recovery';

void test('pool recovery keeps two deposits committed until each independently verified refund', async (t) => {
  const rig = await batchRecoveryRig(t);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: rig.financial.root });
  const options = {
    paths,
    totalDepositAtomic: '2000',
    now: rig.options.now,
    backend: async (child: typeof rig.options.paths) =>
      openBatchBuyerBackend({
        ...rig.options,
        paths: child,
      }),
  };
  let pool = await openBatchBuyerPool(options);
  const second: PaymentSessionTerms = {
    ...rig.financial.terms,
    sellerNodeId: '56'.repeat(32),
  };
  await pool.allocate(second);
  const backend = await pool.backend(second.sellerNodeId);
  const buyer = await backend.create(second);
  const payload = await buyer.open();
  const sellerBackend = openBatchSellerBackend({
    ...rig.options,
    paths: batchSessionPathsIn(
      { GYBLOS_HOME: join(rig.financial.root, 'second') },
      'seller',
    ),
    feePayer: rig.financial.vm.feePayer,
    authorizer: rig.financial.vm.authorizer,
    signer: rig.financial.vm.signer,
  });
  const seller = await sellerBackend.create(second, payload);
  await seller.open(payload);
  await buyer.dispose();
  await seller.dispose();
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '2000',
    availableAtomic: '0',
  });
  const channels = (await pool.list())
    .map((row) => row.stored!.snapshot.channelId)
    .sort();
  await pool.dispose();
  const recover = () => recoverBatchPool({ ...rig.options, paths });
  const first = await recover();
  assert.equal(first.length, 2);
  assert.ok(first.every((result) => result.settlement === null));
  pool = await openBatchBuyerPool(options);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '2000',
    availableAtomic: '0',
  });
  await pool.dispose();
  rig.grace();
  await recover();
  const settled = await recover();
  assert.ok(
    settled.every((result) => result.settlement?.refundedAtomic === '1000'),
  );
  pool = await openBatchBuyerPool(options);
  t.after(pool.dispose);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '0',
    availableAtomic: '2000',
  });
  const restored = await pool.list();
  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.map((row) => row.stored!.snapshot.channelId).sort(),
    channels,
  );
  assert.ok(restored.every((row) => !row.uncertain && row.requestId === null));
});

void test('pool does not credit a native refund whose final proof is temporarily unavailable', async (t) => {
  const rig = await batchRecoveryRig(t);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: rig.financial.root });
  const options = {
    paths,
    totalDepositAtomic: '1000',
    now: rig.options.now,
    backend: async () => assert.fail('Recovery must not open another channel'),
  };
  const recover = () => recoverBatchPool({ ...rig.options, paths });
  await recover();
  await recover();
  rig.grace();
  rig.local.beforeSend(async () => {
    rig.local.hideOriginal(true);
  });
  const waiting = await recover();
  assert.equal(waiting[0]?.settlement, null);
  let pool = await openBatchBuyerPool(options);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
  await pool.dispose();
  const sends = rig.financial.vm.sends();
  rig.local.hideOriginal(false);
  assert.equal((await recover())[0]?.settlement?.refundedAtomic, '1000');
  assert.equal(rig.financial.vm.sends(), sends);
  pool = await openBatchBuyerPool(options);
  t.after(pool.dispose);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '0',
    availableAtomic: '1000',
  });
});
