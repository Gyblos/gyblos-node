// Payment deadlines stop service and freeze the billed prefix; no clock waits, network or funds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { PAYMENT_LIMITS, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { createPaidStreamOutput } from '@gyblos/node/paid-stream-output';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { paidSellerFixture } from './support/paid-seller';

void test('v2 withdrawal grace covers the accepted payload lifetime; v1 keeps its original grace', () => {
  assert.ok(UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds > UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds + 60);
  assert.equal(PAYMENT_LIMITS.withdrawDelay, 60);
});

void test('a payment without enough claim reserve never starts generation and settles zero', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.claimUntil = seller.options.now() + seller.options.settlement.waitMs;
  const { terminal, deltas } = await seller.execute(await seller.request());
  assert.equal(seller.engineCalls.length, 0);
  assert.deepEqual(deltas, []);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.TIMEOUT);
  assert.equal(terminal.charge?.chargedAtomic, '0');
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test('deposit confirmation consuming the claim window refuses the engine after admission', async () => {
  const seller = await paidSellerFixture();
  let now = seller.options.now();
  seller.options.now = () => now;
  seller.payment.control.claimUntil = now + 100;
  const admit = seller.payment.server.admit;
  seller.payment.server.admit = async (...args) => {
    const result = await admit(...args);
    now += 100;
    return result;
  };
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(seller.engineCalls.length, 0);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.TIMEOUT);
  assert.equal(terminal.charge?.chargedAtomic, '0');
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test('payment cutoff ends even an engine ignoring abort and claims only the completed prefix', { timeout: 15000 }, async (context) => {
  const seller = await paidSellerFixture();
  let now = seller.options.now();
  seller.options.now = () => now;
  seller.payment.control.claimUntil = now + 70;
  let started = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let finish = () => {};
  const held = new Promise<void>((resolve) => { finish = resolve; });
  seller.setScript({ deltas: ['Hi'], before: started, hold: held });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let result: Awaited<ReturnType<typeof seller.execute>> | undefined;
  const running = seller.execute(await seller.request()).then((value) => { result = value; });
  try {
    await entered;
    context.mock.timers.tick(19);
    assert.equal(result, undefined);
    now += 20;
    context.mock.timers.tick(1);
    await yieldTurn();
    assert.ok(result, 'the payment deadline must finish the service without waiting for the engine');
    assert.equal(seller.engineCalls[0]?.signal.aborted, true);
    assert.equal(result.terminal.error?.code, PAID_EXECUTION_CODES.TIMEOUT);
    assert.equal(result.terminal.charge?.chargedAtomic, '8');
    assert.equal(seller.payment.calls.settle.length, 1);
    await assert.rejects(seller.engineCalls[0]!.onText!('late'));
    assert.deepEqual(result.deltas, ['Hi']);
    finish();
    await yieldTurn();
    assert.equal(seller.payment.calls.settle.length, 1);
  } finally { finish(); await running; }
});

void test('a stopped paid output cannot revise its charge when an in-flight delivery resolves late', async () => {
  const seller = await paidSellerFixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const output = createPaidStreamOutput(seller.options.meter, { inputTokens: 4, allowance: 8 }, new AbortController().signal,
    async (text) => { if (text === '.') await held; });
  await output.onText('Hi');
  const late = output.onText('.');
  output.stop();
  release();
  await assert.rejects(late);
  assert.equal(output.delivered(), 'Hi');
});

void test('invalid payment deadline metadata starts no engine and cannot charge the buyer', async () => {
  for (const claimUntil of [Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const seller = await paidSellerFixture();
    seller.payment.control.claimUntil = claimUntil;
    const { terminal } = await seller.execute(await seller.request());
    assert.equal(seller.engineCalls.length, 0);
    assert.equal(terminal.charge?.chargedAtomic, '0');
    assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.INTERNAL);
  }
});
