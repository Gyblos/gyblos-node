// Runs the actual withdrawal adapter and signed transactions against the pinned official SBF.
// Synthetic funds only; native balances prove refund destinations, never an RPC status alone.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
} from 'x402-upto-metered';

import { UPTO_CHANNEL_SETTINGS } from '@gyblos/config';

import { nativeChannel } from '../support/paid-native-channel';

const NOW = 1_800_000_000_000;
const FUNDS = 100_000n;
const FULL_REFUND = {
  payer: FUNDS,
  seller: 0n,
  fee: 0n,
  program: 0n,
  escrow: 0n,
};
const DUE =
  NOW / 1000 +
  UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds +
  UPTO_WITHDRAW.graceMarginSeconds;

void test('native withdrawal closes, waits at the exact boundary and refunds the payer only once', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  await value.open();
  const close = await value.withdraw();
  assert.equal(close.step, UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(close.confirmed, true);
  assert.equal(close.transaction, value.withdrawalSignature());
  assert.equal(
    (await value.channel())?.status,
    UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
  );
  value.time(DUE - 1);
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.WAITING);
  assert.equal(value.sends(), 2);
  value.time(DUE);
  const refund = await value.withdraw();
  assert.equal(refund.step, UPTO_WITHDRAW_STEPS.DISTRIBUTED);
  assert.equal(refund.confirmed, true);
  assert.equal(refund.transaction, value.withdrawalSignature());
  assert.deepEqual(await value.balances(), FULL_REFUND);
  assert.equal(
    (await value.channel())?.status,
    UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
  );
  assert.equal(value.sends(), 3);
  assert.equal(await value.replay(), false);
  assert.equal(
    value.failureCode(),
    2,
    'fully signed fresh-blockhash replay reaches native status rejection',
  );
  assert.deepEqual(await value.balances(), FULL_REFUND);
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.NOTHING);
  assert.equal(value.sends(), 3);
});

void test('native close and refund reply loss recover from chain state without another principal transfer', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  await value.open();
  const close = await value.withdraw({ loseReply: true });
  assert.equal(close.step, UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(close.confirmed, false);
  assert.equal(close.transaction, value.withdrawalSignature());
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.WAITING);
  assert.equal(value.sends(), 2);
  value.time(DUE);
  const refund = await value.withdraw({ loseReply: true });
  assert.equal(refund.step, UPTO_WITHDRAW_STEPS.DISTRIBUTED);
  assert.equal(refund.confirmed, false);
  assert.equal(refund.transaction, value.withdrawalSignature());
  assert.deepEqual(await value.balances(), FULL_REFUND);
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.NOTHING);
  assert.equal(value.sends(), 3);
  assert.deepEqual(await value.balances(), FULL_REFUND);
});

void test('native withdrawal recreates the absent payer token account before refunding all principal', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW, deposit: String(FUNDS) });
  await value.open();
  assert.equal((await value.balances()).payer, 0n);
  await value.closeRefundAccount();
  assert.equal(
    (await value.withdraw()).step,
    UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
  );
  value.time(DUE);
  assert.equal((await value.withdraw()).confirmed, true);
  assert.deepEqual(await value.balances(), FULL_REFUND);
});

void test('native withdrawal distributes an already sealed channel without another close', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  await value.open();
  await value.close();
  value.time(DUE);
  await value.seal();
  assert.equal(
    (await value.channel())?.status,
    UPTO_CHANNEL_ACCOUNT.statuses.SEALED,
  );
  const before = value.sends();
  const refund = await value.withdraw();
  assert.equal(refund.step, UPTO_WITHDRAW_STEPS.DISTRIBUTED);
  assert.equal(refund.confirmed, true);
  assert.equal(value.sends(), before + 1);
  assert.deepEqual(await value.balances(), FULL_REFUND);
});

void test('native withdrawal leaves a settled paid charge and its refund unchanged', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  await value.open();
  await value.claim('145');
  const settled = await value.balances();
  assert.deepEqual(settled, {
    payer: FUNDS - 145n,
    seller: 139n,
    fee: 5n,
    program: 1n,
    escrow: 0n,
  });
  const before = value.sends();
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.NOTHING);
  assert.equal(value.sends(), before);
  assert.deepEqual(await value.balances(), settled);
});

void test('native preflight rejects an early seal despite a misleading RPC clock without refunding', async (context) => {
  context.mock.method(Date, 'now', () => NOW);
  const value = await nativeChannel({ now: () => NOW });
  await value.open();
  await value.withdraw();
  const before = await value.balances();
  await assert.rejects(value.withdraw({ blockTime: BigInt(DUE) }), {
    code: UPTO_ERROR_CODES.CHAIN_REJECTED,
  });
  assert.equal(
    (await value.channel())?.status,
    UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
  );
  assert.equal(value.sends(), 2);
  assert.deepEqual(await value.balances(), before);
  assert.equal((await value.withdraw()).step, UPTO_WITHDRAW_STEPS.WAITING);
});
