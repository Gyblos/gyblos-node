// Runs signed SDK transactions in LiteSVM against the pinned official SBF program, not RPC doubles.
// Synthetic mint and funds only; a network label selects treasury constants, never a real network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { UPTO_CHANNEL_ACCOUNT } from 'x402-upto-metered';

import { nativeChannel } from '../support/paid-native-channel';

const NOW = 1_800_000_000_000;
const FUNDS = 100_000n;
const DEPOSIT = 1000n;
const CHARGE = '145';

void test('native SDK open, early payer close, claim and refund conserve actual token balances once', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  assert.ok(value);
  await value.open();
  assert.deepEqual(await value.balances(), {
    payer: FUNDS - DEPOSIT,
    seller: 0n,
    fee: 0n,
    program: 0n,
    escrow: DEPOSIT,
  });
  await value.close();
  assert.equal(
    (await value.channel())?.status,
    UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
  );
  const result = await value.claim(CHARGE);
  assert.equal(result.chargedAtomic, CHARGE);
  assert.equal(result.refundedAtomic, '855');
  const after = await value.balances();
  assert.deepEqual(after, {
    payer: FUNDS - 145n,
    seller: 140n,
    fee: 4n,
    program: 1n,
    escrow: 0n,
  });
  assert.equal(
    after.payer + after.seller + after.fee + after.program + after.escrow,
    FUNDS,
  );
  assert.equal(value.sends(), 2);
  assert.deepEqual(await value.claim(CHARGE), result);
  assert.equal(value.sends(), 2);
  assert.equal(await value.replay(), false);
  assert.equal(
    value.failureCode(),
    2,
    'native status rejection, not transaction-history duplication',
  );
  assert.deepEqual(await value.balances(), after);
});

void test('native zero-delivery settlement returns all token principal', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  assert.ok(value);
  await value.open();
  await value.claim('0');
  assert.deepEqual(await value.balances(), {
    payer: FUNDS,
    seller: 0n,
    fee: 0n,
    program: 0n,
    escrow: 0n,
  });
});

for (const offset of [-1, 0, 1]) {
  void test(`native voucher inclusion at expiry ${offset} seconds`, async (context) => {
    context.mock.method(Date, 'now', () => NOW);
    const value = await nativeChannel({ now: () => NOW });
    assert.ok(value);
    await value.open();
    const before = await value.balances();
    value.atInclusion(value.expiresAt + offset);
    if (offset < 0) {
      await value.claim(CHARGE);
      assert.equal((await value.balances()).payer, FUNDS - 145n);
    } else {
      await assert.rejects(value.claim(CHARGE));
      assert.equal(value.failureCode(), 233);
      assert.deepEqual(
        await value.balances(),
        before,
        'a rejected claim does not refund escrow',
      );
      value.time(NOW / 1000 + 301);
      await value.close();
      value.time(NOW / 1000 + 601);
      await value.refund();
      assert.deepEqual(await value.balances(), {
        payer: FUNDS,
        seller: 0n,
        fee: 0n,
        program: 0n,
        escrow: 0n,
      });
    }
  });
}

for (const offset of [-1, 0, 1]) {
  void test(`native Closing grace boundary ${offset} seconds with a still-live voucher`, async (context) => {
    context.mock.method(Date, 'now', () => NOW);
    // Native boundary isolation only: Gyblos product configuration correctly rejects this short grace.
    const value = await nativeChannel({ now: () => NOW, grace: 60 });
    assert.ok(value);
    await value.open();
    await value.close();
    const before = await value.balances();
    value.atInclusion(NOW / 1000 + 60 + offset);
    if (offset < 0) await value.claim(CHARGE);
    else {
      await assert.rejects(value.claim(CHARGE));
      assert.equal(value.failureCode(), 2);
      assert.deepEqual(await value.balances(), before);
      await value.refund();
      assert.equal((await value.balances()).payer, FUNDS);
    }
  });
}

void test('native inclusion followed by lost confirmation recovers the same claim after expiry', async (context) => {
  let now = NOW;
  context.mock.method(Date, 'now', () => now);
  const value = await nativeChannel({ now: () => now });
  assert.ok(value);
  await value.open();
  value.loseConfirmation(true);
  await assert.rejects(value.claim(CHARGE));
  const paid = await value.balances();
  assert.equal(paid.payer, FUNDS - 145n);
  assert.equal(value.sends(), 2);
  now += 121_000;
  value.loseConfirmation(false);
  const settled = await value.claim(CHARGE);
  assert.equal(settled.chargedAtomic, CHARGE);
  assert.equal(value.sends(), 2);
  assert.deepEqual(await value.balances(), paid);
});
