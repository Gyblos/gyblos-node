// Pins paid admission precedence and financial handoff before the common execution refactor.
// Uses the existing public seller and retry ports with synthetic quotes, engine and payment server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { recountedMeter } from '@gyblos/node/free-meter';
import { createPaidRetry } from '@gyblos/node/paid-retry';
import {
  ENGINE_ERROR_CODES,
  FREE_EXECUTION_STOP_REASONS,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { paidSellerFixture, paymentError } from './support/paid-seller';

void test('unaffordable input wins over busy and does not spend the request id', async () => {
  const seller = await paidSellerFixture({ inputTokens: 19 });
  const request = await seller.request();
  seller.setBusy(true);
  const refused = (await seller.execute(request)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.LIMIT);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.payment.calls.settle.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  seller.setBusy(false);
  seller.options.meter = recountedMeter({
    input: () => 4,
    chat: () => 4,
    count: (text) => [...text].length,
  });
  const accepted = (await seller.execute(request)).terminal;
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.payment?.settlement?.chargedAtomic, '10');
  assert.equal(seller.payment.calls.admit.length, 1);
});

void test('own payment terms are checked before busy without spending the request id', async () => {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  const own = seller.payment.control.description;
  seller.payment.control.description = {
    ...own,
    payTo: 'not-the-quoted-payee',
  };
  seller.setBusy(true);
  const refused = (await seller.execute(request)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  seller.payment.control.description = own;
  seller.setBusy(false);
  const accepted = (await seller.execute(request)).terminal;
  assert.equal(accepted.error, undefined);
  assert.equal(seller.payment.calls.admit.length, 1);
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test('busy after ledger admission spends the id and releases the generation slot', async () => {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  seller.setBusy(true);
  const refused = (await seller.execute(request)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.BUSY);
  assert.equal(seller.payment.calls.admit.length, 0);

  const replay = (await seller.execute(request)).terminal;
  assert.equal(replay.error?.code, PAID_EXECUTION_CODES.REPLAY);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  seller.setBusy(false);
  const next = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(next.error, undefined);
  assert.equal(seller.payment.calls.admit.length, 1);
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test('quote expiry wins over unsupported selection and busy before id use', async () => {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  const now = seller.options.now;
  const selection = seller.options.selection;
  seller.options.now = () => request.quote.offer.expiresAt;
  seller.options.selection = {
    ...selection,
    variant: 'not-the-quoted-variant',
  };
  seller.setBusy(true);
  const refused = (await seller.execute(request)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.EXPIRED);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  seller.options.now = now;
  seller.options.selection = selection;
  seller.setBusy(false);
  const accepted = (await seller.execute(request)).terminal;
  assert.equal(accepted.error, undefined);
  assert.equal(seller.payment.calls.admit.length, 1);
});

void test('cancellation before admission neither spends the id nor calls payments', async () => {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  const controller = new AbortController();
  controller.abort();
  const refused = (await seller.execute(request, controller.signal)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.CANCELLED);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.payment.calls.settle.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  const accepted = (await seller.execute(request)).terminal;
  assert.equal(accepted.error, undefined);
  assert.equal(seller.payment.calls.admit.length, 1);
});

void test('payment admission failure retains replay protection and releases its slot', async () => {
  const seller = await paidSellerFixture();
  const request = await seller.request();
  seller.payment.control.admitError = paymentError(
    PAYMENT_ERROR_CODES.UNAVAILABLE,
  );
  const refused = (await seller.execute(request)).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(seller.payment.calls.admit.length, 1);
  assert.equal(seller.payment.calls.settle.length, 0);
  assert.equal(seller.engineCalls.length, 0);

  seller.payment.control.admitError = undefined;
  const replay = (await seller.execute(request)).terminal;
  assert.equal(replay.error?.code, PAID_EXECUTION_CODES.REPLAY);
  assert.equal(seller.payment.calls.admit.length, 1);

  const next = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(next.error, undefined);
  assert.equal(seller.payment.calls.admit.length, 2);
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test(
  'an interrupted generation hands off its frozen charge without another engine call',
  { timeout: 15000 },
  async (context) => {
    const seller = await paidSellerFixture();
    const settle = seller.payment.server.settle;
    const charges: string[] = [];
    seller.options.payment = {
      ...seller.payment.server,
      async settle(admission, amount) {
        charges.push(amount);
        if (charges.length === 1)
          throw paymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
        return settle(admission, amount);
      },
    };
    const retry = createPaidRetry({
      payment: seller.options.payment,
      delaysMs: [],
      attemptMs: 1000,
    });
    seller.setPendingHook((admission, amount) =>
      retry.queue(admission, amount),
    );
    seller.setScript({
      deltas: ['Hi'],
      error: new EngineError(ENGINE_ERROR_CODES.INTERRUPTED),
    });
    try {
      const request = await seller.request();
      const terminal = (await seller.execute(request)).terminal;
      while (retry.health().queued !== 0)
        await yieldTurn(undefined, { signal: context.signal });
      assert.deepEqual(terminal.error, {
        code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
        delivered: { outputTokens: 2 },
      });
      assert.deepEqual(terminal.payment, {
        pending: {
          channelId: request.payment.channelId,
          chargedAtomic: '8',
          transaction: null,
        },
      });
      assert.deepEqual(charges, ['8', '8']);
      assert.equal(seller.payment.calls.admit.length, 1);
      assert.equal(seller.payment.calls.settle.length, 1);
      assert.equal(seller.engineCalls.length, 1);
      assert.deepEqual(retry.health(), {
        queued: 0,
        settled: 1,
        lapsed: 0,
        failed: 0,
      });
    } finally {
      await retry.stop();
    }
  },
);
