import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';
import { createPaypalSandbox } from '@gyblos/payments-paypal';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { fixture } from './support/paypal-session-fixture';

void test('a contradictory create response keeps the order blocked across restart', async () => {
  for (const details of [
    { status: undefined },
    { status: 'COMPLETED' },
    { intent: 'CAPTURE' },
    { purchase_units: [{ amount: { currency_code: 'USD', value: '2.00' } }] },
    { purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1' }] } }] },
    { purchase_units: [{ payments: { refunds: [{ id: 'REFUND1' }] } }] },
    {
      links: [
        {
          rel: 'approve',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=OTHER',
        },
      ],
    },
    {
      links: [
        {
          rel: 'approve',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1&token=ORDER1',
        },
      ],
    },
  ]) {
    const f = fixture();
    let creates = 0;
    const payment = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) => {
        if (String(input).endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        creates += 1;
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
            ...details,
          },
          { status: 201 },
        );
      },
    });
    const session = await createPaypalSession({ ...f, payment });
    await assert.rejects(session.create());
    assert.equal(session.status().phase, 'creating');
    const restarted = await createPaypalSession({ ...f, payment });
    await assert.rejects(restarted.cancel('ORDER1'));
    await assert.rejects(restarted.create());
    assert.equal(creates, 1);
  }
});

void test('a contradictory authorization response cannot activate or be retried', async () => {
  for (const unitDetails of [
    { custom_id: 'OTHER', payments: {} },
    { amount: { currency_code: 'USD', value: '2.00' }, payments: {} },
    { payments: { captures: [{ id: 'CAPTURE1' }] } },
    { payments: { refunds: [{ id: 'REFUND1' }] } },
  ]) {
    const f = fixture();
    let authorizations = 0;
    const adapter = createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: async (input) => {
        if (String(input).endsWith('/v1/oauth2/token'))
          return Response.json({ access_token: 'synthetic-token' });
        if (String(input).endsWith('/v2/checkout/orders/ORDER1')) {
          const record = f.getState();
          assert.ok(
            record && typeof record === 'object' && 'requestId' in record,
          );
          return Response.json({
            id: 'ORDER1',
            status: 'APPROVED',
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                custom_id: record.requestId,
                amount: { currency_code: 'USD', value: '1.00' },
              },
            ],
          });
        }
        authorizations += 1;
        return Response.json({
          id: 'ORDER1',
          status: 'COMPLETED',
          purchase_units: [
            {
              ...unitDetails,
              payments: {
                authorizations: [
                  {
                    id: 'AUTH1',
                    status: 'CREATED',
                    amount: { currency_code: 'USD', value: '1.00' },
                  },
                ],
                ...unitDetails.payments,
              },
            },
          ],
        });
      },
    });
    const payment = {
      ...f.payment,
      isApproved: adapter.isApproved,
      authorize: adapter.authorize,
    };
    const session = await createPaypalSession({ ...f, payment });
    await session.create();
    await assert.rejects(session.approve('ORDER1'));
    assert.equal(session.status().phase, 'authorizing');
    const restarted = await createPaypalSession({ ...f, payment });
    await assert.rejects(restarted.approve('ORDER1'));
    await assert.rejects(restarted.create());
    assert.equal(authorizations, 1);
  }
});

void test('an interrupted approval revokes its reserved authorization token', async () => {
  const f = fixture();
  let allowed = true;
  let requestId = '';
  let authorizations = 0;
  const adapter = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith('/v2/checkout/orders/ORDER1'))
        return Response.json({
          id: 'ORDER1',
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: requestId,
              amount: { currency_code: 'USD', value: '1.00' },
            },
          ],
        });
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
    },
  });
  const payment = {
    ...f.payment,
    async isApproved(orderId: string, reference: string) {
      requestId = reference;
      const approved = await adapter.isApproved(orderId, reference);
      allowed = false;
      return approved;
    },
    authorize: adapter.authorize,
    discardApproval: adapter.discardApproval,
  };
  const session = await createPaypalSession({ ...f, payment });
  await session.create();
  await assert.rejects(session.approve('ORDER1', () => allowed));
  await assert.rejects(adapter.authorize('ORDER1', requestId));
  assert.equal(authorizations, 0);
});

void test('authorization consumes a matching approved-order token exactly once', async () => {
  let tokens = 0;
  let authorizations = 0;
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) {
        tokens += 1;
        return Response.json({ access_token: 'synthetic-token' });
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
    },
  });
  await assert.rejects(payment.authorize('ORDER1', 'REQUEST1'));
  assert.equal(authorizations, 0);
  assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), true);
  await assert.rejects(payment.authorize('ORDER2', 'REQUEST1'));
  assert.equal(authorizations, 0);
  assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), true);
  await payment.authorize('ORDER1', 'REQUEST1');
  assert.equal(authorizations, 1);
  await assert.rejects(payment.authorize('ORDER1', 'REQUEST1'));
  assert.equal(authorizations, 1);
  assert.equal(tokens, 2);
});

void test('concurrent authorization attempts cannot consume the same approval twice', async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({ access_token: 'synthetic-token' });
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
      calls += 1;
      await wait;
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
    },
  });
  assert.equal(await payment.isApproved('ORDER1', 'REQUEST1'), true);
  const first = payment.authorize('ORDER1', 'REQUEST1');
  try {
    await assert.rejects(payment.isApproved('ORDER1', 'REQUEST1'));
    await assert.rejects(payment.authorize('ORDER1', 'REQUEST1'));
    assert.equal(calls, 1);
  } finally {
    assert.ok(release);
    release();
    await first;
  }
});

void test('authorization requires a valid request reference before any network call', async () => {
  let calls = 0;
  const payment = createPaypalSandbox({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    returnOrigin: 'http://127.0.0.1:8765',
    fetch: async () => {
      calls += 1;
      throw new Error('unexpected network call');
    },
  });
  for (const args of [['ORDER1'], ['ORDER1', 'bad value']]) {
    const result: unknown = Reflect.apply(payment.authorize, payment, args);
    assert.ok(result instanceof Promise);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof PaypalError);
      assert.equal(error.code, PAYPAL_ERROR_CODES.INVALID_RESPONSE);
      return true;
    });
  }
  assert.equal(calls, 0);
});
