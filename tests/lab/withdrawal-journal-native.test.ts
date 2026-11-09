// Durable journal recovery over actual signed instructions and the pinned payment-channel SBF.
// Synthetic balances only: a reopened journal resolves each lost reply without another send.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { UPTO_WITHDRAW, type UptoWithdrawalRecovery } from 'x402-upto-metered';

import { buyerJournalPathsIn, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { openUptoBuyerJournal } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { nativeChannel } from '../support/paid-native-channel';

void test('native close and refund recover their original signatures after private journal reopen', async (context) => {
  const now = 1_800_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const root = await mkdtemp(join(tmpdir(), 'gyb-native-recovery-'));
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
  const value = await nativeChannel({ now: () => now });
  let journal = await openUptoBuyerJournal({ paths, now: () => now });
  const checkpoint = async (): Promise<UptoWithdrawalRecovery> => {
    const entry = await journal.get(value.entry.requestDigest);
    assert.ok(entry?.channelId);
    return {
      previous: entry.withdrawal,
      save: (next) =>
        journal.recordWithdrawal!(
          entry.requestDigest,
          entry.channelId!,
          entry.withdrawal,
          next,
        ),
    };
  };
  try {
    await journal.put(value.entry);
    await value.open();
    for (const refund of [false, true]) {
      if (refund)
        value.time(
          now / 1000 +
            UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds +
            UPTO_WITHDRAW.graceMarginSeconds,
        );
      const before = value.sends();
      const sent = await value.withdraw(
        { loseReply: true },
        await checkpoint(),
      );
      assert.equal(sent.confirmed, false);
      assert.equal(value.sends(), before + 1);
      await journal.close();
      journal = await openUptoBuyerJournal({ paths, now: () => now });
      const saved = await journal.get(value.entry.requestDigest);
      assert.equal(saved?.withdrawal?.transaction, sent.transaction);
      assert.equal(saved?.withdrawal?.pending, true);
      const recovered = await value.withdraw({}, await checkpoint());
      assert.equal(recovered.transaction, sent.transaction);
      assert.equal(recovered.confirmed, true);
      assert.equal(value.sends(), before + 1);
      const resolved = await journal.get(value.entry.requestDigest);
      assert.equal(resolved?.withdrawal?.pending, false);
      assert.equal(
        resolved?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
        'control confirmation does not settle the financial journal',
      );
    }
    assert.deepEqual(await value.balances(), {
      payer: 100_000n,
      seller: 0n,
      fee: 0n,
      program: 0n,
      escrow: 0n,
    });
    const before = value.sends();
    await value.withdraw({}, await checkpoint());
    assert.equal(value.sends(), before);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
