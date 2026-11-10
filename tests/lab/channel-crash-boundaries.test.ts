// Real dead owners are reclaimed; ambiguous locks and missing financial evidence stay blocked.
// Only owned temporary state is mutated; native VM keys/balances never leave the parent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import test from 'node:test';

import { buyerJournalPathsIn } from '@gyblos/config';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PROCESS_LOCK } from '@gyblos/runtime/constants';

import { crashFixture } from '../support/channel-crash-acceptance';
import {
  CHANNEL_CRASH,
  CRASH_ACTIONS,
  CRASH_CUTS,
  CRASH_LOCKS,
} from '../support/channel-crash-constants';

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

for (const kind of Object.values(CRASH_LOCKS)) {
  void test(`abrupt channel recovery refuses ${kind} ownership without changing the journal or chain`, async (context) => {
    context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
    const value = await crashFixture();
    try {
      await value.run(CRASH_ACTIONS.OPEN);
      value.mature();
      const victim = value.start(
        CRASH_ACTIONS.WITHDRAW,
        CRASH_CUTS.CLOSE_CHECKPOINTED,
      );
      await victim.reached();
      assert.equal(await victim.kill(), 'SIGKILL');
      const paths = buyerJournalPathsIn({ GYBLOS_HOME: value.root });
      const before = digest(await readFile(paths.state));
      if (kind === CRASH_LOCKS.MALFORMED)
        await writeFile(paths.lock, '{partial', { mode: 0o600 });
      if (kind === CRASH_LOCKS.FOREIGN)
        await writeFile(
          paths.lock,
          JSON.stringify({ pid: process.pid, host: 'synthetic-other-host' }),
          { mode: 0o600 },
        );
      if (kind === CRASH_LOCKS.LIVE)
        await writeFile(
          paths.lock,
          JSON.stringify({ pid: process.pid, host: hostname() }),
          { mode: 0o600 },
        );
      if (kind === CRASH_LOCKS.GUARD)
        await writeFile(paths.lock + PROCESS_LOCK.guardSuffix, '', {
          mode: 0o600,
          flag: 'wx',
        });
      const lockBefore = digest(await readFile(paths.lock));
      const sends = value.vm.sends();
      const signs = value.signs();
      const balances = await value.balances();
      await assert.rejects(value.run(CRASH_ACTIONS.OBSERVE), {
        message: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
      });
      assert.equal(digest(await readFile(paths.state)), before);
      assert.equal(digest(await readFile(paths.lock)), lockBefore);
      assert.equal(value.vm.sends(), sends);
      assert.equal(value.signs(), signs);
      assert.deepEqual(await value.balances(), balances);
    } finally {
      await value.close();
    }
  });
}

void test('wrong synthetic genesis is refused before payer signing or any native send', async (context) => {
  context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
  const value = await crashFixture();
  try {
    value.badGenesis();
    await assert.rejects(value.run(CRASH_ACTIONS.OPEN), {
      message: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    });
    assert.equal(value.signs(), 0);
    assert.equal(value.vm.sends(), 0);
    assert.equal(await value.saved(), null);
  } finally {
    await value.close();
  }
});

void test('a second SIGKILL during recovery retains the original attempt for a third buyer process', async (context) => {
  context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
  const value = await crashFixture();
  try {
    await value.run(CRASH_ACTIONS.OPEN);
    value.mature();
    const victim = value.start(
      CRASH_ACTIONS.WITHDRAW,
      CRASH_CUTS.CLOSE_INCLUDED,
    );
    await victim.reached();
    assert.equal(await victim.kill(), 'SIGKILL');
    const original = await value.saved();
    const recovering = value.start(
      CRASH_ACTIONS.OBSERVE,
      CRASH_CUTS.RECOVERY_LOCKED,
    );
    await recovering.reached();
    assert.equal(await recovering.kill(), 'SIGKILL');
    assert.deepEqual(await value.saved(), original);
    const signs = value.signs();
    const sends = value.vm.sends();
    const recovered = await value.run(CRASH_ACTIONS.OBSERVE);
    assert.equal(
      recovered.entry?.withdrawal?.transaction,
      original?.withdrawal?.transaction,
    );
    assert.equal(recovered.entry?.withdrawal?.pending, false);
    assert.equal(
      recovered.startupBlocked,
      true,
      'financial recovery still needs the refund',
    );
    assert.equal(value.signs(), signs);
    assert.equal(value.vm.sends(), sends);
  } finally {
    await value.close();
  }
});

void test('restart observes an actual native paid settlement without another deposit or refund', async (context) => {
  context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
  const value = await crashFixture();
  try {
    const victim = value.start(CRASH_ACTIONS.OPEN, CRASH_CUTS.OPEN_INCLUDED);
    await victim.reached();
    assert.equal(await victim.kill(), 'SIGKILL');
    const original = await value.saved();
    assert.ok(original?.channelId);
    await value.claim(original.channelId, '145');
    const before = await value.balances();
    assert.deepEqual(before, {
      payer: CHANNEL_CRASH.funds - 145n,
      seller: 140n,
      fee: 4n,
      program: 1n,
      escrow: 0n,
    });
    const sends = value.vm.sends();
    const signs = value.signs();
    const recovered = await value.run(CRASH_ACTIONS.OBSERVE);
    assert.equal(recovered.entry?.state, PAYMENT_CHANNEL_STATES.SETTLED);
    assert.equal(recovered.entry?.chargedAtomic, '145');
    assert.equal(recovered.financial?.refundedAtomic, '855');
    assert.equal(recovered.startupBlocked, false);
    assert.equal(value.vm.sends(), sends);
    assert.equal(value.signs(), signs);
    assert.deepEqual(await value.balances(), before);
  } finally {
    await value.close();
  }
});

void test('confirmed native refund without readable financial evidence stays blocked until proof returns', async (context) => {
  context.mock.method(Date, 'now', () => CHANNEL_CRASH.now);
  const value = await crashFixture();
  try {
    await value.run(CRASH_ACTIONS.OPEN);
    value.mature();
    await value.run(CRASH_ACTIONS.WITHDRAW);
    await value.run(CRASH_ACTIONS.OBSERVE);
    value.grace();
    const victim = value.start(
      CRASH_ACTIONS.WITHDRAW,
      CRASH_CUTS.REFUND_INCLUDED,
    );
    await victim.reached();
    assert.equal(await victim.kill(), 'SIGKILL');
    value.hideTransactions(true);
    const sends = value.vm.sends();
    const signs = value.signs();
    const unknown = await value.run(CRASH_ACTIONS.OBSERVE);
    assert.equal(unknown.entry?.withdrawal?.pending, false);
    assert.equal(unknown.entry?.state, PAYMENT_CHANNEL_STATES.OPEN);
    assert.equal(unknown.financial?.chargedAtomic, null);
    assert.equal(unknown.startupBlocked, true);
    value.hideTransactions(false);
    const proven = await value.run(CRASH_ACTIONS.OBSERVE);
    assert.equal(proven.entry?.state, PAYMENT_CHANNEL_STATES.SETTLED);
    assert.equal(proven.financial?.refundedAtomic, CHANNEL_CRASH.deposit);
    assert.equal(proven.startupBlocked, false);
    assert.equal(value.vm.sends(), sends);
    assert.equal(value.signs(), signs);
  } finally {
    await value.close();
  }
});
