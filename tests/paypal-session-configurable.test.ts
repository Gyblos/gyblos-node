// Exercises configurable sandbox limits with isolated in-memory dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';
import { createPaypalSandbox } from '@gyblos/payments-paypal';

import { fixture } from './support/paypal-session-fixture';

void test('a selected sandbox limit covers multiple replies and captures only usage', async () => {
  const f = fixture();
  let requestedLimit = 0;
  const payment = {
    ...f.payment,
    async beginReview(
      _order: string,
      _request: string,
      authorizationId: string,
    ) {
      return {
        capture: (cents: number) => f.payment.capture(authorizationId, cents),
        release() {},
      };
    },
    async create(_id: string, _state?: string, limitCents?: number) {
      requestedLimit = limitCents ?? 0;
      return f.payment.create();
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create(undefined, 500);
  await session.approve(order.orderId);
  assert.equal(requestedLimit, 500);
  assert.equal(session.status().limitCents, 500);
  for (let index = 0; index < 11; index += 1) {
    const answer = await session.message(
      order.orderId,
      `message ${index}`,
      16,
      `MSG${index}`,
    );
    await session.acknowledge(order.orderId, answer.messageId);
  }
  assert.equal((await session.finish(order.orderId)).spentCents, 110);
  assert.equal(f.calls.at(-1), 'capture:110');
});

void test('a caller cannot increase the adapter capture ceiling by supplying an extra argument', async () => {
  let captures = 0;
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      if (String(input).endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      captures += 1;
      return Response.json({
        id: 'CAPTURE1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '2.00' },
      });
    },
  });
  await assert.rejects(
    Reflect.apply(payment.capture, undefined, ['AUTH1', 200, 1000]),
  );
  assert.equal(captures, 0);
});

void test('sandbox sends and verifies exactly the chosen order and authorization amount', async () => {
  for (const limit of [100, 500, 1000]) {
    const price = (limit / 100).toFixed(2);
    let sentAmount: unknown;
    let captureBody: unknown;
    let authorized = false;
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        if (url.endsWith('/v2/checkout/orders')) {
          const body: unknown = JSON.parse(String(init?.body));
          sentAmount = body;
          return Response.json(
            {
              id: 'ORDER1',
              status: 'CREATED',
              links: [
                {
                  rel: 'approve',
                  href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
                },
              ],
            },
            { status: 201 },
          );
        }
        if (url.endsWith('/v2/checkout/orders/ORDER1') && authorized)
          return Response.json({
            id: 'ORDER1',
            status: 'COMPLETED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                custom_id: 'REQUEST1',
                amount: { currency_code: 'USD', value: price },
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH1',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: price },
                    },
                  ],
                },
              },
            ],
          });
        if (url.endsWith('/v2/checkout/orders/ORDER1'))
          return Response.json({
            id: 'ORDER1',
            status: 'APPROVED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                custom_id: 'REQUEST1',
                amount: { currency_code: 'USD', value: price },
              },
            ],
          });
        if (url.endsWith('/authorize')) {
          authorized = true;
          return Response.json({
            id: 'ORDER1',
            status: 'COMPLETED',
            purchase_units: [
              {
                amount: { currency_code: 'USD', value: price },
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH1',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: price },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.endsWith('/v2/payments/authorizations/AUTH1'))
          return Response.json({
            id: 'AUTH1',
            status: 'CREATED',
            amount: { currency_code: 'USD', value: price },
          });
        if (url.endsWith('/capture')) {
          captureBody = JSON.parse(String(init?.body));
          const charge = limit === 100 ? '0.10' : '1.10';
          return Response.json({
            id: 'CAPTURE1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: charge },
          });
        }
        throw new Error('unexpected synthetic request');
      },
    });
    await payment.create('REQUEST1', undefined, limit);
    assert.match(
      JSON.stringify(sentAmount),
      new RegExp(`"value":"${price.replace('.', '\\.')}"`),
    );
    const differentLimit = limit === 100 ? 500 : 100;
    await assert.rejects(
      payment.isApproved('ORDER1', 'REQUEST1', differentLimit),
    );
    assert.equal(await payment.isApproved('ORDER1', 'REQUEST1', limit), true);
    await assert.rejects(
      payment.authorize('ORDER1', 'REQUEST1', differentLimit),
    );
    assert.equal(await payment.isApproved('ORDER1', 'REQUEST1', limit), true);
    assert.equal(
      (await payment.authorize('ORDER1', 'REQUEST1', limit)).authorizationId,
      'AUTH1',
    );
    const lease = await payment.beginReview(
      'ORDER1',
      'REQUEST1',
      'AUTH1',
      limit,
    );
    await assert.rejects(lease.capture(limit + 1));
    const charge = limit === 100 ? 10 : 110;
    assert.equal((await lease.capture(charge)).captureId, 'CAPTURE1');
    assert.match(
      JSON.stringify(captureBody),
      new RegExp(`"value":"${(charge / 100).toFixed(2).replace('.', '\\.')}"`),
    );
    lease.release();
  }
});

void test('a restored configurable session refuses a mismatched PayPal amount before inference', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async beginReview(
      _order: string,
      _request: string,
      _auth: string,
      limit?: number,
    ) {
      assert.equal(limit, 500);
      throw new Error('synthetic PayPal amount mismatch');
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create(undefined, 500);
  await session.approve(order.orderId);
  const restored = await createPaypalSession({ ...f, payment });
  await assert.rejects(
    restored.message(order.orderId, 'prompt', 16, 'MESSAGE1'),
  );
  assert.equal(f.calls.includes('generate'), false);
  assert.equal(
    f.calls.some((call) => call.startsWith('capture:')),
    false,
  );
});

void test('unsupported limits do not create orders or write a session', async () => {
  for (const limit of [0, 101, 499, 1001, -1, 1.5, Number.NaN]) {
    const f = fixture();
    const session = await createPaypalSession(f);
    await assert.rejects(session.create(undefined, limit));
    assert.equal(f.getState(), null);
    assert.deepEqual(f.calls, []);
  }
});

void test('a ten-dollar limit allows one hundred replies and rejects the next', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async beginReview(
      _order: string,
      _request: string,
      authorizationId: string,
    ) {
      return {
        capture: (cents: number) => f.payment.capture(authorizationId, cents),
        release() {},
      };
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create(undefined, 1000);
  await session.approve(order.orderId);
  for (let index = 0; index < 100; index += 1) {
    const answer = await session.message(
      order.orderId,
      `message ${index}`,
      16,
      `LIMIT${index}`,
    );
    await session.acknowledge(order.orderId, answer.messageId);
  }
  await assert.rejects(
    session.message(order.orderId, 'over limit', 16, 'OVER'),
  );
  assert.equal((await session.finish(order.orderId)).spentCents, 1000);
  assert.equal(f.calls.at(-1), 'capture:1000');
});

void test('a restored pending response cannot bypass PayPal limit verification', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async beginReview(
      _order: string,
      _request: string,
      _auth: string,
      limit?: number,
    ) {
      if (limit !== 500) throw new Error('synthetic PayPal amount mismatch');
      return {
        async capture() {
          return { captureId: 'CAPTURE1' };
        },
        release() {},
      };
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create(undefined, 500);
  await session.approve(order.orderId);
  await session.message(order.orderId, 'prompt', 16, 'MESSAGE1');
  const pending = f.getState();
  assert.ok(pending && typeof pending === 'object');
  f.setState({ ...pending, limitCents: 1000, maxMessageAttempts: 120 });
  const restored = await createPaypalSession({ ...f, payment });
  await assert.rejects(restored.acknowledge(order.orderId, 'MESSAGE1'));
  assert.equal(restored.status().phase, 'message_pending');
});

void test('a restored session cannot generate if it expires while PayPal is checked', async () => {
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const f = fixture();
    const payment = {
      ...f.payment,
      async beginReview() {
        now += 31 * 60_000;
        return {
          async capture() {
            return { captureId: 'CAPTURE1' };
          },
          release() {},
        };
      },
    };
    const session = await createPaypalSession({ ...f, payment });
    const order = await session.create(undefined, 500);
    await session.approve(order.orderId);
    const restored = await createPaypalSession({ ...f, payment });
    await assert.rejects(
      restored.message(order.orderId, 'prompt', 16, 'MESSAGE1'),
    );
    assert.equal(f.calls.includes('generate'), false);
  } finally {
    Date.now = originalNow;
  }
});
