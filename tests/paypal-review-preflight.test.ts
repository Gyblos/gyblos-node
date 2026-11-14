import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSandbox } from '@gyblos/payments-paypal';

function order() {
  return {
    id: 'ORDER1',
    status: 'COMPLETED',
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        custom_id: 'REQUEST1',
        amount: { currency_code: 'USD', value: '1.00' },
        payments: {
          authorizations: [
            {
              id: 'AUTH1',
              status: 'CREATED',
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        },
      },
    ],
  };
}
function authorization() {
  return {
    id: 'AUTH1',
    status: 'CREATED',
    amount: { currency_code: 'USD', value: '1.00' },
  };
}
function fixture(orderValue: unknown, authorizationValue: unknown) {
  const calls: string[] = [];
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      assert.equal(init?.method, undefined);
      if (url.endsWith('/v2/checkout/orders/ORDER1')) {
        calls.push('order');
        return Response.json(orderValue);
      }
      if (url.endsWith('/v2/payments/authorizations/AUTH1')) {
        calls.push('authorization');
        return Response.json(authorizationValue);
      }
      throw new Error('Unexpected sandbox request');
    },
  });
  return { calls, payment };
}

void test('manual review verifies the exact sandbox order and uncaptured authorization using reads only', async () => {
  const f = fixture(order(), authorization());
  const lease = await f.payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  lease.release();
  assert.deepEqual(f.calls, ['order', 'authorization']);
});

void test('manual review verifies the configured sandbox limit on every provider resource', async () => {
  for (const limit of [500, 1000]) {
    const price = (limit / 100).toFixed(2);
    const original = order();
    original.purchase_units[0]!.amount.value = price;
    original.purchase_units[0]!.payments.authorizations[0]!.amount.value =
      price;
    const active = authorization();
    active.amount.value = price;
    const lease = await fixture(original, active).payment.beginReview(
      'ORDER1',
      'REQUEST1',
      'AUTH1',
      limit,
    );
    lease.release();
    await assert.rejects(
      fixture(original, {
        ...active,
        amount: { currency_code: 'USD', value: '1.00' },
      }).payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1', limit),
    );
    await assert.rejects(
      fixture(original, {
        ...active,
        amount: { currency_code: 'EUR', value: price },
      }).payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1', limit),
    );
    await assert.rejects(
      fixture(order(), active).payment.beginReview(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
        limit,
      ),
    );
  }
});

void test('manual review rejects inconsistent or previously captured sandbox terms', async () => {
  const badOrders = [
    { ...order(), id: 'OTHER' },
    { ...order(), intent: 'CAPTURE' },
    { ...order(), status: 'APPROVED' },
    { ...order(), purchase_units: [] },
    {
      ...order(),
      purchase_units: [{ ...order().purchase_units[0], custom_id: 'OTHER' }],
    },
    {
      ...order(),
      purchase_units: [
        {
          ...order().purchase_units[0],
          payments: {
            ...order().purchase_units[0]!.payments,
            captures: [{ id: 'CAPTURE1', status: 'PENDING' }],
          },
        },
      ],
    },
  ];
  const badAuthorizations = [
    { ...authorization(), id: 'OTHER' },
    { ...authorization(), status: 'CAPTURED' },
    { ...authorization(), status: 'PARTIALLY_CAPTURED' },
    { ...authorization(), amount: { currency_code: 'USD', value: '0.50' } },
    { ...authorization(), amount: { currency_code: 'EUR', value: '1.00' } },
  ];
  for (const badOrder of badOrders)
    await assert.rejects(
      fixture(badOrder, authorization()).payment.beginReview(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
      ),
    );
  for (const badAuthorization of badAuthorizations)
    await assert.rejects(
      fixture(order(), badAuthorization).payment.beginReview(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
      ),
    );
});

void test('a sandbox review holds exclusive payment access until its one capture finishes', async () => {
  const calls: string[] = [];
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json(order());
      if (url.endsWith('/v2/payments/authorizations/AUTH1'))
        return Response.json(authorization());
      if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
        assert.equal(init?.method, 'POST');
        calls.push('capture');
        return Response.json({
          id: 'CAPTURE1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '0.20' },
        });
      }
      throw new Error('Unexpected request');
    },
  });
  const lease = await payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  await assert.rejects(payment.capture('AUTH1', 20));
  await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
  lease.release();
  await assert.rejects(lease.capture(20));
  const next = await payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  lease.release();
  await assert.rejects(payment.capture('AUTH1', 20));
  assert.deepEqual(await next.capture(20), { captureId: 'CAPTURE1' });
  await assert.rejects(next.capture(20));
  next.release();
  await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
  assert.deepEqual(calls, ['capture']);
});

void test('a sandbox review cannot begin while another capture is in flight', async () => {
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
        entered();
        await paused;
        return Response.json({
          id: 'CAPTURE1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '0.20' },
        });
      }
      throw new Error('A concurrent review should not issue a request');
    },
  });
  const capture = payment.capture('AUTH1', 20);
  await reached;
  await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
  resume();
  await capture;
});

void test('a previous ordinary capture blocks a later review even when provider reads are stale', async () => {
  for (const lostResponse of [false, true]) {
    let reads = 0;
    let captures = 0;
    const payment = createPaypalSandbox({
      clientId: 'synthetic-id',
      clientSecret: 'synthetic-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
          captures += 1;
          if (lostResponse) throw new Error('synthetic lost response');
          return Response.json({
            id: 'CAPTURE1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '0.20' },
          });
        }
        reads += 1;
        if (url.endsWith('/v2/checkout/orders/ORDER1'))
          return Response.json(order());
        if (url.endsWith('/v2/payments/authorizations/AUTH1'))
          return Response.json(authorization());
        throw new Error('Unexpected request');
      },
    });
    if (lostResponse) await assert.rejects(payment.capture('AUTH1', 20));
    else await payment.capture('AUTH1', 20);
    await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
    assert.equal(captures, 1);
    assert.equal(reads, 0);
  }
});

void test('a locally invalid capture does not poison subsequent sandbox operations', async () => {
  const f = fixture(order(), authorization());
  await assert.rejects(f.payment.capture('AUTH1', 0));
  assert.deepEqual(f.calls, []);
  const lease = await f.payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  lease.release();
  assert.deepEqual(f.calls, ['order', 'authorization']);
});

void test('a completed or uncertain void blocks a later review with stale provider reads', async () => {
  for (const lostResponse of [false, true]) {
    let reads = 0;
    const payment = createPaypalSandbox({
      clientId: 'synthetic-id',
      clientSecret: 'synthetic-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        if (url.endsWith('/v2/payments/authorizations/AUTH1/void')) {
          if (lostResponse) throw new Error('synthetic lost void');
          return new Response(null, { status: 204 });
        }
        reads += 1;
        if (url.endsWith('/v2/checkout/orders/ORDER1'))
          return Response.json(order());
        if (url.endsWith('/v2/payments/authorizations/AUTH1'))
          return Response.json(authorization());
        throw new Error('Unexpected request');
      },
    });
    if (lostResponse) await assert.rejects(payment.void('AUTH1'));
    else await payment.void('AUTH1');
    await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
    assert.equal(reads, 0);
  }
});

void test('releasing a review cannot admit another payment while its capture is in flight', async () => {
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let captures = 0;
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json(order());
      if (url.endsWith('/v2/payments/authorizations/AUTH1'))
        return Response.json(authorization());
      if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
        captures += 1;
        entered();
        await paused;
        return Response.json({
          id: 'CAPTURE1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '0.20' },
        });
      }
      throw new Error('Unexpected request');
    },
  });
  const lease = await payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  const pending = lease.capture(20);
  await reached;
  lease.release();
  await assert.rejects(payment.capture('AUTH1', 20));
  resume();
  await pending;
  assert.equal(captures, 1);
});

void test('a lost reviewed capture blocks another review even if PayPal still reports CREATED', async () => {
  let captures = 0;
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json(order());
      if (url.endsWith('/v2/payments/authorizations/AUTH1'))
        return Response.json(authorization());
      if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
        captures += 1;
        throw new Error('synthetic lost response');
      }
      throw new Error('Unexpected request');
    },
  });
  const lease = await payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1');
  await assert.rejects(lease.capture(20));
  lease.release();
  await assert.rejects(payment.beginReview('ORDER1', 'REQUEST1', 'AUTH1'));
  await assert.rejects(payment.capture('AUTH1', 20));
  assert.equal(captures, 1);
});
