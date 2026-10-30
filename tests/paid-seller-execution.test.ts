// The paid seller service end to end against a recording payment server: deposits only after every
// refusal check, charges the recounted delivered tokens within the ceiling, and settles even after the
// buyer leaves. Each terminal is checked with the buyer's own stream verifier. No chain or files.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_ERROR_CODES,
  FREE_EXECUTION_STOP_REASONS,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import {
  FEE,
  PAID_CEILING,
  paidSellerFixture,
  paymentError,
} from './support/paid-seller';

void test('a paid request deposits, streams, charges the recount and settles', async () => {
  const seller = await paidSellerFixture();
  const paid = await seller.request();
  const { terminal, deltas } = await seller.execute(paid);
  assert.deepEqual(deltas, ['Hi', '.']);
  assert.equal(terminal.result?.text, 'Hi.');
  // Four input tokens at one unit and three output tokens at two.
  assert.deepEqual(terminal.charge, {
    inputTokens: 4,
    outputTokens: 3,
    chargedAtomic: '10',
  });
  assert.equal(terminal.payment?.settlement?.refundedAtomic, '10');
  const [admitted] = seller.payment.calls.admit;
  assert.deepEqual(admitted?.terms, {
    ...(await seller.payment.server.describe()),
    buyer: paid.quote.offer.buyer,
    requestDigest: paid.quote.offer.requestDigest,
    maxAtomic: PAID_CEILING,
    expiresAt: paid.quote.offer.expiresAt,
  });
  assert.equal(admitted?.terms.protocolFeeBps, FEE.protocolFeeBps);
  assert.deepEqual(
    seller.payment.calls.settle.map((call) => call.chargedAtomic),
    ['10'],
  );
});

void test('an input the ceiling cannot pay for is refused before any deposit or id use', async () => {
  // 19 input units leave one, less than one output token costs.
  const seller = await paidSellerFixture({ inputTokens: 19 });
  const paid = await seller.request();
  const { terminal } = await seller.execute(paid);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.LIMIT);
  assert.equal(terminal.charge, undefined);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.engineCalls.length, 0);
});

void test('generation stops with BUDGET_EXHAUSTED once the deposit is spent', async () => {
  const seller = await paidSellerFixture();
  seller.setScript({ deltas: [...'abcdefghij'] });
  const { terminal, deltas } = await seller.execute(await seller.request());
  // 16 units after the input pay for 8 output tokens.
  assert.equal(seller.engineCalls[0]?.maxTokens, 8);
  assert.equal(deltas.join(''), 'abcdefgh');
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  assert.deepEqual(terminal.charge, {
    inputTokens: 4,
    outputTokens: 8,
    chargedAtomic: PAID_CEILING,
  });
  assert.equal(terminal.payment?.settlement?.refundedAtomic, '0');
});

void test('a buyer leaving mid-stream is charged what was delivered and still settled', async () => {
  const seller = await paidSellerFixture();
  const controller = new AbortController();
  const { terminal } = await seller.execute(
    await seller.request(),
    controller.signal,
    async () => controller.abort(),
  );
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.CANCELLED);
  assert.equal(terminal.error?.delivered?.outputTokens, 2);
  assert.equal(terminal.charge?.chargedAtomic, '8');
  assert.equal(terminal.payment?.settlement?.chargedAtomic, '8');
});

void test('an engine stop reports its reason and charges only delivered output', async () => {
  const seller = await paidSellerFixture();
  const interrupted = new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
  seller.setScript({ deltas: ['Hi'], error: interrupted });
  const first = (await seller.execute(await seller.request(1))).terminal;
  assert.deepEqual(first.error, {
    code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
    delivered: { outputTokens: 2 },
  });
  assert.equal(first.charge?.chargedAtomic, '8');
  seller.setScript({ deltas: [], error: interrupted });
  const second = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(second.error?.delivered, undefined);
  assert.equal(second.charge?.chargedAtomic, '0');
  assert.equal(second.payment?.settlement?.refundedAtomic, PAID_CEILING);
});

void test('payment server refusals map to paid codes and never generate', async () => {
  for (const [code, expected] of [
    [
      PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      PAID_EXECUTION_CODES.PAYMENT_REJECTED,
    ],
    [PAYMENT_ERROR_CODES.CHANNEL_REUSED, PAID_EXECUTION_CODES.PAYMENT_REJECTED],
    [PAYMENT_ERROR_CODES.UNAVAILABLE, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE],
    [PAYMENT_ERROR_CODES.TERMS_EXPIRED, PAID_EXECUTION_CODES.EXPIRED],
  ] as const) {
    const seller = await paidSellerFixture();
    seller.payment.control.admitError = paymentError(code);
    const { terminal } = await seller.execute(await seller.request());
    assert.equal(terminal.error?.code, expected, code);
    assert.equal(terminal.payment, undefined);
    assert.equal(seller.engineCalls.length, 0);
    assert.equal(seller.payment.calls.settle.length, 0);
  }
});

void test('a replayed request is refused without a second deposit', async () => {
  const seller = await paidSellerFixture();
  const paid = await seller.request();
  await seller.execute(paid);
  const { terminal } = await seller.execute(paid);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.REPLAY);
  assert.equal(seller.payment.calls.admit.length, 1);
});

void test('a claim not confirmed in time is pending and handed over for retry', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.settle = { kind: 'hang' };
  const { terminal } = await seller.execute(await seller.request(1));
  assert.deepEqual(terminal.payment, {
    pending: {
      channelId: 'c'.repeat(64),
      chargedAtomic: '10',
      transaction: null,
    },
  });
  assert.deepEqual(
    seller.pending.map((entry) => entry.chargedAtomic),
    ['10'],
  );
  // A retryable failure is pending too; a stopping daemon does not wait at all.
  seller.payment.control.settle = {
    kind: 'fail',
    error: paymentError(PAYMENT_ERROR_CODES.UNAVAILABLE),
  };
  const failed = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(failed.payment?.pending?.chargedAtomic, '10');
  seller.daemon.abort();
  seller.payment.control.settle = { kind: 'hang' };
  const started = Date.now();
  const stopping = (await seller.execute(await seller.request(3))).terminal;
  assert.ok(stopping.payment?.pending);
  assert.ok(Date.now() - started < 50);
  assert.equal(seller.pending.length, 3);
  // A stopping daemon never starts a claim.
  assert.equal(seller.payment.calls.settle.length, 2);
});

void test('a claim the chain refuses for good is reported lapsed', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.settle = {
    kind: 'fail',
    error: paymentError(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED),
  };
  const { terminal } = await seller.execute(await seller.request());
  assert.deepEqual(terminal.payment, {
    lapsed: { channelId: 'c'.repeat(64) },
  });
  assert.equal(seller.pending.length, 0);
});

void test('a quote whose payment terms are not the server’s own is refused before deposit', async () => {
  const seller = await paidSellerFixture();
  const own = await seller.payment.server.describe();
  seller.payment.control.description = { ...own, payTo: 'someone-else' };
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(seller.payment.calls.admit.length, 0);
});

void test('a busy engine or declared metering is refused before deposit', async () => {
  const seller = await paidSellerFixture();
  seller.setBusy(true);
  const busy = (await seller.execute(await seller.request(1))).terminal;
  assert.equal(busy.error?.code, PAID_EXECUTION_CODES.BUSY);
  assert.equal(seller.payment.calls.admit.length, 0);
  const { DECLARED_METER } = await import('@gyblos/node/free-meter');
  const declared = await paidSellerFixture({ meter: DECLARED_METER });
  const refused = (await declared.execute(await declared.request())).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(declared.payment.calls.admit.length, 0);
});

void test('a buyer leaving while the engine runs is a cancellation, not an engine stop', async () => {
  const seller = await paidSellerFixture();
  const controller = new AbortController();
  seller.setScript({
    deltas: ['Hi'],
    before: () => controller.abort(),
    error: new EngineError(ENGINE_ERROR_CODES.INTERRUPTED),
  });
  const { terminal } = await seller.execute(
    await seller.request(),
    controller.signal,
  );
  assert.deepEqual(terminal.error, {
    code: PAID_EXECUTION_CODES.CANCELLED,
    delivered: { outputTokens: 2 },
  });
});
