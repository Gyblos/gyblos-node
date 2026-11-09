// Real buyer process death, SDK payment instructions and native LiteSVM balances; no public RPC.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runChannelCrash } from '../support/channel-crash-acceptance';
import { CHANNEL_CRASH, CRASH_CUTS } from '../support/channel-crash-constants';

for (const cut of Object.values(CRASH_CUTS)) {
  if (cut === CRASH_CUTS.RECOVERY_LOCKED) continue;
  void test(`native channel recovery after SIGKILL at ${cut}`, async (context) => {
    context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
    const result = await runChannelCrash(cut);
    assert.equal(
      result.signal,
      'SIGKILL',
      'the buyer must actually die without journal.close',
    );
    assert.equal(result.retainedIdentity, true);
    assert.equal(result.replacementSignatures, 0);
    assert.equal(result.replacementSends, 0);
    const unsentOpen = [
      CRASH_CUTS.OPEN_BEFORE_CHECKPOINT,
      CRASH_CUTS.OPEN_CHECKPOINTED,
      CRASH_CUTS.OPEN_SIGNED,
    ].some((item) => item === cut);
    assert.equal(result.totalSends, unsentOpen ? 0 : 3);
    assert.equal(result.startupBlocked, false);
    assert.equal(result.chargedAtomic, '0');
    assert.deepEqual(result.balances, {
      payer: CHANNEL_CRASH.funds,
      seller: 0n,
      fee: 0n,
      program: 0n,
      escrow: 0n,
    });
  });
}
