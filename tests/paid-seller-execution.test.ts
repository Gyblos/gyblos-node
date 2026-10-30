// The paid seller service end to end against a recording payment server: deposits only after every
// refusal check, charges the recounted delivered tokens within the ceiling, and settles even after the
// buyer leaves. Each terminal is checked with the buyer's own stream verifier. No chain or files.
import assert from 'node:assert/strict';
import test from 'node:test';

import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { DECLARED_METER, recountedMeter } from '@gyblos/node/free-meter';
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
  const first = await seller.request(1);
  const { terminal } = await seller.execute(first);
  assert.deepEqual(terminal.payment, {
    pending: {
      channelId: first.payment.channelId,
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
  // A daemon stopping mid-generation reports the claim pending without starting it.
  seller.setScript({
    deltas: ['Hi', '.'],
    before: () => seller.daemon.abort(),
  });
  const stopping = (await seller.execute(await seller.request(3))).terminal;
  assert.equal(stopping.payment?.pending?.chargedAtomic, '10');
  assert.equal(seller.pending.length, 3);
  assert.equal(seller.payment.calls.settle.length, 2);
  // Once stopped, a new request is refused before any deposit.
  const refused = (await seller.execute(await seller.request(4))).terminal;
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(seller.payment.calls.admit.length, 3);
});

void test('a claim the chain refuses for good is reported lapsed', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.settle = {
    kind: 'fail',
    error: paymentError(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED),
  };
  const paid = await seller.request();
  const { terminal } = await seller.execute(paid);
  assert.deepEqual(terminal.payment, {
    lapsed: { channelId: paid.payment.channelId },
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

void test('more output than free execution allows is refused before any deposit', async () => {
  const seller = await paidSellerFixture({
    maxTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens + 1,
  });
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.LIMIT);
  assert.equal(seller.payment.calls.admit.length, 0);
});

void test('an unreachable payment server is unavailable before any deposit', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.describeError = new Error('rpc down');
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(seller.payment.calls.admit.length, 0);
});

void test('a deposit that lands after the request gave up is handed over to settle at zero', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.admitDelayMs = 100;
  const paid = await seller.request();
  const { terminal } = await seller.execute(paid);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(seller.engineCalls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    seller.pending.map((entry) => [
      entry.admission.channelId,
      entry.chargedAtomic,
    ]),
    [[paid.payment.channelId, '0']],
  );
});

void test('a slow claim within the wait settles, and a broken one is surfaced, not retried', async () => {
  const seller = await paidSellerFixture();
  seller.payment.control.settle = { kind: 'delay', ms: 10 };
  const slow = (await seller.execute(await seller.request(1))).terminal;
  assert.equal(slow.payment?.settlement?.chargedAtomic, '10');
  for (const error of [
    paymentError(PAYMENT_ERROR_CODES.ALREADY_SETTLED),
    new Error('bug'),
  ]) {
    seller.payment.control.settle = { kind: 'fail', error };
    const failed = (
      await seller.execute(await seller.request(2 + seller.failures.length))
    ).terminal;
    assert.equal(failed.payment?.pending?.chargedAtomic, '10');
  }
  seller.payment.control.settle = { kind: 'throw', error: new Error('sync') };
  const thrown = (await seller.execute(await seller.request(9))).terminal;
  assert.equal(thrown.payment?.pending?.chargedAtomic, '10');
  assert.equal(seller.failures.length, 3);
  assert.equal(seller.pending.length, 0);
});

void test('a pending hook that throws neither repeats nor costs the terminal', async () => {
  const seller = await paidSellerFixture();
  let calls = 0;
  seller.setPendingHook(() => {
    calls++;
    throw new Error('hook bug');
  });
  seller.payment.control.settle = {
    kind: 'fail',
    error: paymentError(PAYMENT_ERROR_CODES.UNAVAILABLE),
  };
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(terminal.payment?.pending?.chargedAtomic, '10');
  assert.equal(calls, 1);
});

void test('a second request while one generates is busy and deposits nothing', async () => {
  const seller = await paidSellerFixture();
  let finish = () => {};
  seller.setScript({
    deltas: ['Hi'],
    hold: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  });
  const first = seller.execute(await seller.request(1));
  while (seller.engineCalls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const second = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(second.error?.code, PAID_EXECUTION_CODES.BUSY);
  assert.equal(seller.payment.calls.admit.length, 1);
  finish();
  assert.equal((await first).terminal.result?.text, 'Hi');
});

void test('engine text that is invalid or differs from the stream stops the generation', async () => {
  const seller = await paidSellerFixture();
  seller.setScript({ deltas: ['Hi', '\uD800'] });
  const invalid = (await seller.execute(await seller.request(1))).terminal;
  assert.deepEqual(invalid.error, {
    code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INVALID_RESPONSE,
    delivered: { outputTokens: 2 },
  });
  assert.equal(invalid.charge?.chargedAtomic, '8');
  seller.setScript({ deltas: ['Hi'], final: 'Bye' });
  const differs = (await seller.execute(await seller.request(2))).terminal;
  assert.equal(differs.error?.code, PAID_EXECUTION_CODES.ENGINE);
  assert.equal(differs.charge?.chargedAtomic, '0');
});

void test('a delivery failure mid-stream ends with a terminal and a settled deposit', async () => {
  const seller = await paidSellerFixture();
  const { terminal } = await seller.execute(
    await seller.request(),
    new AbortController().signal,
    async () => {
      throw new Error('stream reset');
    },
  );
  // A delivery that failed outright is not a buyer's cancellation: nothing is charged.
  assert.deepEqual(terminal.error, { code: PAID_EXECUTION_CODES.ENGINE });
  assert.equal(terminal.charge?.chargedAtomic, '0');
  assert.ok(terminal.payment?.settlement);
  assert.equal(seller.payment.calls.settle.length, 1);
});

void test('a meter that miscounts delivered output charges nothing rather than guessing', async () => {
  for (const miscount of [Number.NaN, 0]) {
    const seller = await paidSellerFixture({
      meter: {
        ...recountedMeter({
          input: () => 4,
          count: (text) => [...text].length,
        }),
        delivered: () => miscount,
      },
    });
    seller.setScript({
      deltas: ['Hi'],
      error: new EngineError(ENGINE_ERROR_CODES.INTERRUPTED),
    });
    const { terminal } = await seller.execute(await seller.request());
    assert.deepEqual(terminal.error, { code: PAID_EXECUTION_CODES.INTERNAL });
    assert.equal(terminal.charge?.chargedAtomic, '0');
    assert.ok(terminal.payment?.settlement);
  }
});

void test('a daemon stopping just before the deposit takes no deposit', async () => {
  const seller = await paidSellerFixture();
  const describe = seller.payment.server.describe;
  seller.payment.server.describe = async () => {
    const own = await describe();
    seller.daemon.abort();
    return own;
  };
  const { terminal } = await seller.execute(await seller.request());
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(seller.payment.calls.admit.length, 0);
});
