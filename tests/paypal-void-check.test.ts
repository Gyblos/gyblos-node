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

void test('an interrupted void can be checked without claiming payment history or sending a payment', async () => {
  const f = fixture(order(), { ...authorization(), status: 'VOIDED' });
  await f.payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1');
  assert.deepEqual(f.calls, ['order', 'authorization']);
  await assert.rejects(
    fixture(order(), authorization()).payment.checkVoidedAuthorization(
      'ORDER1',
      'REQUEST1',
      'AUTH1',
    ),
  );
  await assert.rejects(
    fixture(
      { ...order(), id: 'OTHER' },
      { ...authorization(), status: 'VOIDED' },
    ).payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1'),
  );
});

void test('void verification requires the exact configured sandbox limit', async () => {
  for (const limit of [500, 1000]) {
    const price = (limit / 100).toFixed(2);
    const original = order();
    original.purchase_units[0]!.amount.value = price;
    original.purchase_units[0]!.payments.authorizations[0]!.amount.value =
      price;
    const voided = {
      ...authorization(),
      status: 'VOIDED',
      amount: { currency_code: 'USD', value: price },
    };
    await fixture(original, voided).payment.checkVoidedAuthorization(
      'ORDER1',
      'REQUEST1',
      'AUTH1',
      limit,
    );
    await assert.rejects(
      fixture(order(), voided).payment.checkVoidedAuthorization(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
        limit,
      ),
    );
    await assert.rejects(
      fixture(original, {
        ...voided,
        amount: { currency_code: 'EUR', value: price },
      }).payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1', limit),
    );
  }
});

void test('void verification rejects mismatched and malformed provider evidence', async () => {
  const valid = { ...authorization(), status: 'VOIDED' };
  const badOrders = [
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
          amount: { currency_code: 'EUR', value: '1.00' },
        },
      ],
    },
    {
      ...order(),
      purchase_units: [
        {
          ...order().purchase_units[0],
          payments: {
            authorizations: [{ id: 'AUTH1', status: 'PARTIALLY_CAPTURED' }],
          },
        },
      ],
    },
    {
      ...order(),
      purchase_units: [
        {
          ...order().purchase_units[0],
          payments: { authorizations: [{ id: 'OTHER' }] },
        },
      ],
    },
  ];
  const badAuthorizations = [
    { ...valid, id: 'OTHER' },
    { ...valid, status: 'PENDING' },
    { ...valid, amount: { currency_code: 'USD', value: '0.50' } },
    { ...valid, amount: { currency_code: 'EUR', value: '1.00' } },
  ];
  for (const value of badOrders)
    await assert.rejects(
      fixture(value, valid).payment.checkVoidedAuthorization(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
      ),
    );
  for (const value of badAuthorizations)
    await assert.rejects(
      fixture(order(), value).payment.checkVoidedAuthorization(
        'ORDER1',
        'REQUEST1',
        'AUTH1',
      ),
    );
});

void test('checking a void stays available after an uncertain void but does not unblock payments', async () => {
  const calls: string[] = [];
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/void')) {
        calls.push('void');
        throw new Error('lost');
      }
      assert.equal(init?.method, undefined);
      if (url.endsWith('/v2/checkout/orders/ORDER1')) {
        calls.push('order');
        return Response.json(order());
      }
      if (url.endsWith('/v2/payments/authorizations/AUTH1')) {
        calls.push('authorization');
        return Response.json({ ...authorization(), status: 'VOIDED' });
      }
      throw new Error('unexpected call');
    },
  });
  await assert.rejects(payment.void('AUTH1'));
  await payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1');
  await assert.rejects(payment.capture('AUTH1', 20));
  await assert.rejects(payment.void('AUTH1'));
  assert.deepEqual(calls, ['void', 'order', 'authorization']);
});

void test('void verification excludes concurrent local payment operations', async () => {
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
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
        entered();
        await paused;
        return Response.json(order());
      }
      if (url.endsWith('/v2/payments/authorizations/AUTH1')) {
        calls.push('authorization');
        return Response.json({ ...authorization(), status: 'VOIDED' });
      }
      throw new Error('unexpected call');
    },
  });
  const pending = payment.checkVoidedAuthorization(
    'ORDER1',
    'REQUEST1',
    'AUTH1',
  );
  await reached;
  try {
    await assert.rejects(payment.capture('AUTH1', 20));
    await assert.rejects(payment.void('AUTH1'));
    await assert.rejects(
      payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1'),
    );
  } finally {
    resume();
  }
  await pending;
  assert.deepEqual(calls, ['order', 'authorization']);
});

void test('void verification cannot run while a payment operation is in flight', async () => {
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const calls: string[] = [];
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/void')) {
        calls.push('void');
        entered();
        await paused;
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected provider check');
    },
  });
  const pending = payment.void('AUTH1');
  await reached;
  try {
    await assert.rejects(
      payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1'),
    );
  } finally {
    resume();
  }
  await pending;
  assert.deepEqual(calls, ['void']);
});

void test('a failed read releases the void-check gate without claiming confirmation', async () => {
  let fail = true;
  const payment = createPaypalSandbox({
    clientId: 'synthetic-id',
    clientSecret: 'synthetic-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders/ORDER1')) {
        if (fail) throw new Error('offline');
        return Response.json(order());
      }
      if (url.endsWith('/v2/payments/authorizations/AUTH1'))
        return Response.json({ ...authorization(), status: 'VOIDED' });
      throw new Error('unexpected provider call');
    },
  });
  await assert.rejects(
    payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1'),
  );
  fail = false;
  await payment.checkVoidedAuthorization('ORDER1', 'REQUEST1', 'AUTH1');
});
