// Native no-deposit recovery is distinct from a refund: the source-built program never receives the open.
import assert from 'node:assert/strict';
import test from 'node:test';

import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import { buyerPaymentsUnresolved } from '@gyblos/node/buyer-chain';
import {
  createBatchBuyer,
  inspectBatchPool,
  inspectBatchSession,
  openBatchBuyerPool,
  recoverBatchPool,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchNativeFinancial } from '../support/batch-native';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('an expired never-submitted batch opening releases only its unfunded reservation without signing or refunding', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await batchNativeFinancial(() => now, {
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
  });
  await rig.buyer.open();
  const id = rig.buyer.snapshot().channelId;
  await rig.dispose();
  rig.vm.expire();
  const paths = batchPoolPathsIn({ GYBLOS_HOME: rig.root });
  const local = sessionNativeRpc(rig.vm);
  let signs = 0;
  const payer = {
    address: rig.vm.payer.address,
    signTransactions: async (
      ...args: Parameters<typeof rig.vm.payer.signTransactions>
    ) => {
      signs++;
      return rig.vm.payer.signTransactions(...args);
    },
    signMessages: async (
      ...args: Parameters<typeof rig.vm.payer.signMessages>
    ) => {
      signs++;
      return rig.vm.payer.signMessages(...args);
    },
  };
  const recovered = await recoverBatchPool({
    paths,
    payer,
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
  });
  assert.equal(recovered.length, 1);
  assert.equal(Reflect.get(recovered[0]!, 'notCreated'), true);
  assert.equal(recovered[0]!.confirmed, true);
  assert.equal(recovered[0]!.settlement, null);
  assert.equal(recovered[0]!.transaction, null);
  assert.equal(signs, 0);
  assert.equal(rig.vm.sends(), 0);
  assert.equal(await rig.vm.balance(rig.terms.buyer), rig.before.buyer);
  const pool = await openBatchBuyerPool({
    paths,
    totalDepositAtomic: '1000',
    now: () => now,
    backend: async () => assert.fail('No new financial backend'),
  });
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '0',
    availableAtomic: '1000',
  });
  const rows = await pool.list();
  assert.equal(rows[0]!.refundedAtomic, '0');
  assert.equal(rows[0]!.uncertain, false);
  assert.equal(rows[0]!.stored!.snapshot.channelId, id);
  await pool.dispose();
  const again = await recoverBatchPool({
    paths,
    payer,
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
  });
  assert.equal(Reflect.get(again[0]!, 'notCreated'), true);
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = rig.root;
  try {
    assert.equal(await buyerPaymentsUnresolved(), false);
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
  }
  const stored = await inspectBatchSession(paths.legacy);
  assert.equal(Reflect.get(stored!, 'notCreated'), true);
  assert.equal((await inspectBatchPool(paths))[0]!.refundedAtomic, '0');
  const reopened = await createBatchBuyer({
    terms: rig.terms,
    paths: batchSessionPathsIn({ GYBLOS_HOME: rig.root }, 'buyer'),
    payer,
    now: () => now,
    hints: async () => assert.fail('Never replace original hints'),
  });
  try {
    await assert.rejects(reopened.open(), { code: SESSION_CODES.CLOSED });
    await assert.rejects(
      reopened.begin({
        requestId: '11'.repeat(16),
        requestDigest: '22'.repeat(32),
        maxAtomic: '100',
      }),
      { code: SESSION_CODES.CLOSED },
    );
  } finally {
    await reopened.dispose();
  }
  assert.equal(signs, 0);
});
