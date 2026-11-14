// Actual SIGKILL/reaping over the current batch store; the source-built program, balances and keys survive.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config/home';

import { batchRecoveryCrash } from '../support/batch-recovery-crash';
import { CRASH_ACTIONS, CRASH_CUTS } from '../support/channel-crash-constants';

for (const cut of [
  CRASH_CUTS.OPEN_BEFORE_CHECKPOINT,
  CRASH_CUTS.OPEN_SIGNED,
  CRASH_CUTS.OPEN_CHECKPOINTED,
  CRASH_CUTS.OPEN_INCLUDED,
]) {
  void test(`batch opening resumes its original authority after SIGKILL at ${cut}`, async (t) => {
    const rig = await batchRecoveryCrash();
    t.after(() => rig.financial.seller().dispose());
    const child = rig.start(CRASH_ACTIONS.OPEN, cut);
    t.after(() => child.kill());
    await child.reached();
    const path = batchSessionPathsIn(
      { GYBLOS_HOME: rig.financial.root },
      'buyer',
    ).state;
    const before = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(await child.kill(), 'SIGKILL');
    await rig.start(CRASH_ACTIONS.OPEN).result();
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.hints, before.hints);
    assert.equal(after.salt, before.salt);
    if (before.channelId) assert.equal(after.channelId, before.channelId);
    assert.equal(
      await rig.financial.vm.balance(rig.financial.vm.payer.address),
      rig.financial.before.buyer - 1000n,
    );
    assert.equal(rig.financial.vm.sends(), 1, 'one original deposit');
    assert.deepEqual(rig.signs(), {
      transactionSigns: cut === CRASH_CUTS.OPEN_BEFORE_CHECKPOINT ? 2 : 1,
      messageSigns: cut === CRASH_CUTS.OPEN_SIGNED ? 2 : 1,
    });
    assert.deepEqual(rig.messages(), {
      transactionMessages: 1,
      voucherMessages: 1,
    });
  });
}

for (const cut of [
  CRASH_CUTS.CLOSE_BEFORE_CHECKPOINT,
  CRASH_CUTS.CLOSE_CHECKPOINTED,
  CRASH_CUTS.CLOSE_INCLUDED,
  CRASH_CUTS.REFUND_BEFORE_CHECKPOINT,
  CRASH_CUTS.REFUND_CHECKPOINTED,
  CRASH_CUTS.REFUND_INCLUDED,
]) {
  void test(`batch buyer-only recovery survives SIGKILL at ${cut}`, async (t) => {
    const rig = await batchRecoveryCrash();
    await rig.fund();
    const refund = cut.startsWith('refund');
    if (refund) {
      await rig.start(CRASH_ACTIONS.WITHDRAW).result();
      await rig.start(CRASH_ACTIONS.WITHDRAW).result();
      rig.grace();
    }
    const child = rig.start(CRASH_ACTIONS.WITHDRAW, cut);
    t.after(() => child.kill());
    await child.reached();
    assert.equal(await child.kill(), 'SIGKILL');
    await rig.start(CRASH_ACTIONS.WITHDRAW).result();
    await rig.start(CRASH_ACTIONS.WITHDRAW).result();
    if (!refund) rig.grace();
    const done = await rig.start(CRASH_ACTIONS.WITHDRAW).result();
    assert.deepEqual(done.financial, {
      chargedAtomic: '0',
      refundedAtomic: '1000',
    });
    assert.equal(done.runtimeBlocked, false);
    assert.equal(done.startupBlocked, false);
    assert.equal(
      await rig.financial.vm.balance(rig.financial.vm.payer.address),
      rig.financial.before.buyer,
    );
    assert.equal(
      rig.financial.vm.sends(),
      3,
      'one deposit, one close and one refund',
    );
  });
}
