import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSandbox } from '@gyblos/payments-paypal';

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
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
          },
        ],
      });
    }
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
  const authorization = await payment.authorize(order.orderId);
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
