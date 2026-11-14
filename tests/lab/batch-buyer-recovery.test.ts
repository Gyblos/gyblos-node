// Real batch journal and SDK/program recovery without a seller process; all keys and RPC are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config/home';
import { WITHDRAW_STEPS } from '@gyblos/payments-upto';
import {
  inspectBatchSession,
  recoverBatchBuyer,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';

import { batchNativeFinancial } from '../support/batch-native';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('a buyer independently closes and refunds its persisted batch channel while the seller is offline', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await batchNativeFinancial(() => now, {
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
  });
  await rig.seller().open(await rig.buyer.open());
  const channelId = rig.buyer.snapshot().channelId;
  await rig.dispose();
  const local = sessionNativeRpc(rig.vm);
  const options = {
    paths: batchSessionPathsIn({ GYBLOS_HOME: rig.root }, 'buyer'),
    payer: rig.vm.payer,
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
  };
  const closing = await recoverBatchBuyer(options);
  assert.ok(closing);
  assert.equal(closing.channelId, channelId);
  assert.equal(closing.step, WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(closing.settlement, null);
  now += (rig.terms.withdrawDelaySeconds + 10) * 1000;
  rig.vm.time(now / 1000);
  let settled = await recoverBatchBuyer(options);
  if (!settled?.settlement) settled = await recoverBatchBuyer(options);
  assert.ok(settled?.settlement);
  assert.equal(settled.settlement.chargedAtomic, '0');
  assert.equal(settled.settlement.refundedAtomic, rig.terms.depositAtomic);
  assert.equal(await rig.vm.balance(rig.terms.buyer), rig.before.buyer);
  assert.equal(
    (await inspectBatchSession(options.paths))?.snapshot.state,
    SESSION_STATES.CLOSED,
  );
  const sends = rig.vm.sends();
  await recoverBatchBuyer(options);
  assert.equal(
    rig.vm.sends(),
    sends,
    'recovery never sends a second refund or deposit',
  );
});
