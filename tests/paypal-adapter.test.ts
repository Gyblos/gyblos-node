import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSandbox } from '@gyblos/payments-paypal';

void test('sandbox adapter authorizes and captures only its fixed USD order', async () => {
  const paths: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, 'https://api-m.sandbox.paypal.com');
    paths.push(new URL(url).pathname);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'synthetic-token' });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-token');
    if (url.endsWith('/v2/checkout/orders')) {
      return Response.json({ id: 'ORDER1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] });
    }
    if (url.endsWith('/v2/checkout/orders/ORDER1/authorize')) {
      return Response.json({ id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED', amount: { currency_code: 'USD', value: '1.00' } }] } }] });
    }
    if (url.endsWith('/v2/payments/authorizations/AUTH1/capture')) {
      return Response.json({ id: 'CAPTURE1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } });
    }
    throw new Error('Unexpected request');
  };
  const payment = createPaypalSandbox({ clientId: 'test-id', clientSecret: 'test-secret', fetch: fetchMock });
  const order = await payment.create();
  const authorization = await payment.authorize(order.orderId);
  const capture = await payment.capture(authorization.authorizationId);
  assert.equal(capture.captureId, 'CAPTURE1');
  assert.ok(paths.includes('/v2/checkout/orders/ORDER1/authorize'));
});

void test('a pending capture is never accepted as completed', async () => {
  const fetchMock: typeof fetch = async (input) => String(input).endsWith('/v1/oauth2/token')
    ? Response.json({ access_token: 'synthetic-token' })
    : Response.json({ id: 'CAPTURE1', status: 'PENDING', amount: { currency_code: 'USD', value: '1.00' } });
  const payment = createPaypalSandbox({ clientId: 'test-id', clientSecret: 'test-secret', fetch: fetchMock });
  await assert.rejects(payment.capture('AUTH1'));
});
