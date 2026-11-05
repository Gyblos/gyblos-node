import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSandbox } from '@gyblos/payments-paypal';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

void test('sandbox adapter authorizes and captures only its fixed USD order', async () => {
  const paths: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, 'https://api-m.sandbox.paypal.com');
    paths.push(new URL(url).pathname);
    if (url.endsWith('/v1/oauth2/token'))
      return Response.json({ access_token: 'synthetic-token' });
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer synthetic-token',
    );
    if (url.endsWith('/v2/checkout/orders')) {
      assert.equal(
        new Headers(init?.headers).get('PayPal-Request-Id'),
        'REQUEST1',
      );
      const requestBody: unknown = JSON.parse(String(init?.body));
      assert.deepEqual(requestBody, {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            amount: { currency_code: 'USD', value: '1.00' },
            custom_id: 'REQUEST1',
          },
        ],
        application_context: {
          return_url: 'http://127.0.0.1:8765/paypal/approved',
          cancel_url: 'http://127.0.0.1:8765/paypal/cancelled',
        },
      });
      return Response.json({
        id: 'ORDER1',
        status: 'CREATED',
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
          },
        ],
      });
    }
    if (url.endsWith('/v2/checkout/orders/ORDER1'))
      return Response.json({
        id: 'ORDER1',
        status: 'APPROVED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'REQUEST1',
            amount: { currency_code: 'USD', value: '1.00' },
          },
        ],
      });
    if (url.endsWith('/v2/checkout/orders/ORDER1/authorize')) {
      return Response.json({
        id: 'ORDER1',
        status: 'COMPLETED',
        purchase_units: [
          {
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
      });
    }
    if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
      return Response.json({
        id: 'CAPTURE1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '1.00' },
      });
    }
    throw new Error('Unexpected request');
  };
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  const order = await payment.create('REQUEST1');
  assert.equal(await payment.isApproved(order.orderId, 'REQUEST1'), true);
  const authorization = await payment.authorize(order.orderId, 'REQUEST1');
  const capture = await payment.capture(authorization.authorizationId);
  assert.equal(capture.captureId, 'CAPTURE1');
  assert.ok(paths.includes('/v2/checkout/orders/ORDER1/authorize'));
});

void test('a pending capture is never accepted as completed', async () => {
  const fetchMock: typeof fetch = async (input) =>
    String(input).endsWith('/v1/oauth2/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : Response.json({
          id: 'CAPTURE1',
          status: 'PENDING',
          amount: { currency_code: 'USD', value: '1.00' },
        });
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  await assert.rejects(payment.capture('AUTH1'));
});

void test('an accepted but unfinished void does not release a payment', async () => {
  const fetchMock: typeof fetch = async (input) =>
    String(input).endsWith('/v1/oauth2/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : Response.json({ status: 'PENDING' }, { status: 202 });
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  await assert.rejects(payment.void('AUTH1'));
});

function sandboxWithVoidResponse(response: Response) {
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v1/oauth2/token'))
      return Response.json({ access_token: 'synthetic-token' });
    assert.equal(
      new URL(String(input)).pathname,
      '/v2/payments/authorizations/AUTH1/void',
    );
    assert.equal(
      new Headers(init?.headers).get('prefer'),
      'return=representation',
    );
    assert.equal(
      new Headers(init?.headers).get('paypal-request-id'),
      'void-AUTH1',
    );
    return response;
  };
  return createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
}

function isUnresolved(error: unknown) {
  assert.ok(error instanceof PaypalError);
  assert.equal(error.code, PAYPAL_ERROR_CODES.UNRESOLVED);
  assert.equal(error.message, PAYPAL_ERROR_CODES.UNRESOLVED);
  assert.equal('cause' in error, false);
  return true;
}

void test('a matching completed void representation confirms the void', async () => {
  const payment = sandboxWithVoidResponse(
    Response.json({
      id: 'AUTH1',
      status: 'VOIDED',
      amount: { currency_code: 'USD', value: '1.00' },
    }),
  );
  await payment.void('AUTH1');
});

void test('a matching void representation may omit the optional amount', async () => {
  const payment = sandboxWithVoidResponse(
    Response.json({ id: 'AUTH1', status: 'VOIDED' }),
  );
  await payment.void('AUTH1');
});

void test('a no-content void response confirms the void', async () => {
  const payment = sandboxWithVoidResponse(new Response(null, { status: 204 }));
  await payment.void('AUTH1');
});

void test('a void representation must match the authorization, state and amount', async () => {
  const correctAmount = { currency_code: 'USD', value: '1.00' };
  const invalid = [
    null,
    {},
    [],
    'invalid',
    { id: 'AUTH2', status: 'VOIDED', amount: correctAmount },
    { id: 'AUTH1', status: 'PENDING', amount: correctAmount },
    { id: 'AUTH1', status: 'VOIDED', amount: null },
    { id: 'AUTH1', status: 'VOIDED', amount: [] },
    { id: 'AUTH1', status: 'VOIDED', amount: {} },
    {
      id: 'AUTH1',
      status: 'VOIDED',
      amount: { currency_code: 'EUR', value: '1.00' },
    },
    {
      id: 'AUTH1',
      status: 'VOIDED',
      amount: { currency_code: 'USD', value: '0.10' },
    },
  ];
  for (const value of invalid)
    await assert.rejects(
      sandboxWithVoidResponse(Response.json(value)).void('AUTH1'),
      isUnresolved,
    );
  await assert.rejects(
    sandboxWithVoidResponse(
      new Response('SYNTHETIC_PRIVATE_MARKER', { status: 200 }),
    ).void('AUTH1'),
    isUnresolved,
  );
  await assert.rejects(
    sandboxWithVoidResponse(new Response('', { status: 200 })).void('AUTH1'),
    isUnresolved,
  );
  for (const status of [201, 202, 206, 400, 500])
    await assert.rejects(
      sandboxWithVoidResponse(
        Response.json(
          { id: 'AUTH1', status: 'VOIDED', amount: correctAmount },
          { status },
        ),
      ).void('AUTH1'),
      isUnresolved,
    );
});

void test('failed sandbox authentication does not send a void', async () => {
  let voidCalls = 0;
  const fetchMock: typeof fetch = async (input) => {
    if (String(input).endsWith('/v1/oauth2/token'))
      return new Response(null, { status: 401 });
    voidCalls += 1;
    return new Response(null, { status: 204 });
  };
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  await assert.rejects(payment.void('AUTH1'), {
    name: 'PaypalError',
    code: PAYPAL_ERROR_CODES.UNAVAILABLE,
  });
  assert.equal(voidCalls, 0);
});

void test('approval is read from PayPal and bound to the same order', async () => {
  const fetchMock: typeof fetch = async (input) =>
    String(input).endsWith('/v1/oauth2/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : Response.json({
          id: 'ORDER1',
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: 'REQUEST1',
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        });
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), true);
  await assert.rejects(payment.isApproved('ORDER2', 'REQUEST1'));
});

void test('a final partial capture sends and verifies only the spent cents', async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token'))
      return Response.json({ access_token: 'synthetic-token' });
    requests.push(String(init?.body));
    return Response.json({
      id: 'CAPTURE1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '0.20' },
    });
  };
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  assert.deepEqual(await payment.capture('AUTH1', 20), {
    captureId: 'CAPTURE1',
  });
  assert.deepEqual(JSON.parse(requests[0] ?? ''), {
    amount: { currency_code: 'USD', value: '0.20' },
    final_capture: true,
  });
  for (const invalid of [0, 101, 1.5, -1])
    await assert.rejects(payment.capture('AUTH1', invalid));
  assert.equal(requests.length, 1);
});

void test('a partial capture with an unexpected amount or currency remains unresolved', async () => {
  for (const amount of [
    { currency_code: 'USD', value: '1.00' },
    { currency_code: 'EUR', value: '0.20' },
  ]) {
    const fetchMock: typeof fetch = async (input) =>
      String(input).endsWith('/v1/oauth2/token')
        ? Response.json({ access_token: 'synthetic-token' })
        : Response.json({ id: 'CAPTURE1', status: 'COMPLETED', amount });
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: fetchMock,
    });
    await assert.rejects(payment.capture('AUTH1', 20));
  }
});

void test('sandbox checkout links cannot target a nonstandard port', async () => {
  const fetchMock: typeof fetch = async (input) =>
    String(input).endsWith('/v1/oauth2/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : Response.json({
          id: 'ORDER1',
          status: 'CREATED',
          links: [
            {
              rel: 'payer-action',
              href: 'https://www.sandbox.paypal.com:444/checkoutnow?token=ORDER1',
            },
          ],
        });
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: fetchMock,
  });
  await assert.rejects(payment.create('REQUEST1'));
});
