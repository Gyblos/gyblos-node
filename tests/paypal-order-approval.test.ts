import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';
import { createPaypalSandbox } from '@gyblos/payments-paypal';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { fixture } from './support/paypal-session-fixture';

void test('each desktop checkout can bind a private return state to its URLs', async () => {
  const state = 'a'.repeat(43);
  let body: unknown;
  let requests = 0;
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      requests += 1;
      if (String(input).endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'ORDER1',
        status: 'CREATED',
        links: [
          {
            rel: 'approve',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
          },
        ],
      });
    },
  });
  await assert.rejects(payment.create('REQUEST1', 'not-a-valid-state'));
  assert.equal(requests, 0);
  await payment.create('REQUEST1', state);
  assert.deepEqual(body, {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        amount: { currency_code: 'USD', value: '1.00' },
        custom_id: 'REQUEST1',
      },
    ],
    application_context: {
      return_url: `http://127.0.0.1:8765/paypal/approved?state=${state}`,
      cancel_url: `http://127.0.0.1:8765/paypal/cancelled?state=${state}`,
    },
  });
});

void test('only a known pending order is treated as not yet approved', async () => {
  for (const status of ['CREATED', 'PAYER_ACTION_REQUIRED']) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
        String(input).endsWith('/v1/oauth2/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json({ id: 'ORDER1', status }),
    });
    assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), false);
  }
});

void test('contradictory or malformed order statuses are not treated as pending', async () => {
  for (const status of [
    undefined,
    null,
    'COMPLETED',
    'VOIDED',
    'SAVED',
    'UNKNOWN',
  ]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
        String(input).endsWith('/v1/oauth2/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json({ id: 'ORDER1', status }),
    });
    await assert.rejects(
      payment.isApproved('ORDER1', 'REQUEST1'),
      (error: unknown) => {
        assert.ok(error instanceof PaypalError);
        assert.equal(error.code, PAYPAL_ERROR_CODES.INVALID_RESPONSE);
        return true;
      },
    );
  }
});

void test('a pending response with contradictory order terms is not treated as safe', async () => {
  for (const details of [
    { intent: 'CAPTURE' },
    { purchase_units: [] },
    { purchase_units: [{ custom_id: 'OTHER' }] },
    { purchase_units: [{ amount: { currency_code: 'USD', value: '2.00' } }] },
  ]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
        String(input).endsWith('/v1/oauth2/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json({ id: 'ORDER1', status: 'CREATED', ...details }),
    });
    await assert.rejects(payment.isApproved('ORDER1', 'REQUEST1'));
  }
});

void test('unfinished HTTP responses cannot confirm a payment mutation', async () => {
  for (const status of [202, 207]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        if (url.endsWith('/v2/checkout/orders'))
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
            { status },
          );
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
        if (url.endsWith('/authorize'))
          return Response.json(
            {
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
            },
            { status },
          );
        return Response.json(
          {
            id: 'CAPTURE1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '1.00' },
          },
          { status },
        );
      },
    });
    await assert.rejects(payment.create('REQUEST1'));
    assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), true);
    await assert.rejects(payment.authorize('ORDER1', 'REQUEST1'));
    await assert.rejects(payment.capture('AUTH1'));
    await assert.rejects(payment.refund('CAPTURE1'));
  }
});

void test('approval requires the original order terms before authorization', async () => {
  const amount = { currency_code: 'USD', value: '1.00' };
  const unit = { amount, custom_id: 'REQUEST1' };
  const valid = {
    id: 'ORDER1',
    status: 'APPROVED',
    intent: 'AUTHORIZE',
    purchase_units: [unit],
  };
  for (const response of [
    { ...valid, intent: 'CAPTURE' },
    { ...valid, purchase_units: [] },
    { ...valid, purchase_units: [unit, unit] },
    { ...valid, purchase_units: [{ ...unit, custom_id: 'OTHER' }] },
    { ...valid, purchase_units: [{ amount }] },
    {
      ...valid,
      purchase_units: [{ ...unit, amount: { ...amount, value: '2.00' } }],
    },
    {
      ...valid,
      purchase_units: [
        { ...unit, amount: { ...amount, currency_code: 'EUR' } },
      ],
    },
  ]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
        String(input).endsWith('/v1/oauth2/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json(response),
    });
    await assert.rejects(payment.isApproved('ORDER1', 'REQUEST1'));
  }
});

void test('explicit prior or malformed payments cannot start a new authorization', async () => {
  for (const payments of [
    null,
    [],
    { authorizations: null },
    { authorizations: [{ id: 'AUTH1' }] },
    { captures: 'unexpected' },
    { captures: [{ id: 'CAPTURE1' }] },
    { refunds: [{ id: 'REFUND1' }] },
    { refunds: 'unexpected' },
  ]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
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
                  payments,
                },
              ],
            }),
    });
    await assert.rejects(payment.isApproved('ORDER1', 'REQUEST1'));
  }
});

void test('only a complete HTTP 200 order response can authorize', async () => {
  for (const status of [202, 206]) {
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) =>
        String(input).endsWith('/v1/oauth2/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json(
              {
                id: 'ORDER1',
                status: 'APPROVED',
                intent: 'AUTHORIZE',
                purchase_units: [
                  {
                    custom_id: 'REQUEST1',
                    amount: { currency_code: 'USD', value: '1.00' },
                  },
                ],
              },
              { status },
            ),
    });
    await assert.rejects(payment.isApproved('ORDER1', 'REQUEST1'));
  }
});

void test('a pending approval cannot authorize before the buyer approves', async () => {
  const f = fixture();
  let orderStatus = 'CREATED';
  let authorizations = 0;
  let requestId = '';
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders')) {
        requestId = new Headers(init?.headers).get('paypal-request-id') ?? '';
        return Response.json({
          id: 'ORDER1',
          status: 'CREATED',
          links: [
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
            },
          ],
        });
      }
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json({
          id: 'ORDER1',
          status: orderStatus,
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: requestId,
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        });
      if (url.endsWith('/v2/checkout/orders/ORDER1/authorize')) {
        assert.equal(init?.method, 'POST');
        authorizations += 1;
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
      throw new Error('Unexpected synthetic request');
    },
  });
  const session = await createPaypalSession({ ...f, payment });
  await session.create();
  await assert.rejects(session.approve('ORDER1'), (error: unknown) => {
    assert.ok(error instanceof PaypalError);
    assert.equal(error.code, PAYPAL_ERROR_CODES.NOT_APPROVED);
    return true;
  });
  assert.equal(session.status().phase, 'created');
  assert.equal(authorizations, 0);
  orderStatus = 'APPROVED';
  assert.equal((await session.approve('ORDER1')).phase, 'active');
  assert.equal(authorizations, 1);
});
