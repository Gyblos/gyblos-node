import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalInference } from '@gyblos/node/paypal-inference';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { createPaypalSandbox } from '@gyblos/payments-paypal';

import { fixture, start } from './support/paypal-session-fixture';

void test('a pre-cancelled legacy request does not check or reserve a payment', async () => {
  const f = fixture();
  let checks = 0;
  f.payment.isApproved = async () => {
    checks += 1;
    return true;
  };
  const service = await createPaypalInference(f);
  await service.create('synthetic', 16);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.execute('ORDER1', 'synthetic', 16, controller.signal),
  );
  assert.equal(checks, 0);
  assert.deepEqual(f.calls, ['create']);
});

void test('a legacy disconnect during the authorization journal write sends no payment', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const write = f.journal.write;
  let count = 0;
  f.journal.write = async (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'phase' in value &&
      value.phase === 'authorizing'
    ) {
      count += 1;
      if (count === 2) {
        reached?.();
        await wait;
      }
    }
    await write(value);
  };
  const service = await createPaypalInference(f);
  await service.create('synthetic', 16);
  const controller = new AbortController();
  const executing = service.execute(
    'ORDER1',
    'synthetic',
    16,
    controller.signal,
  );
  await writing;
  controller.abort();
  assert.ok(release);
  release();
  await assert.rejects(executing);
  const restarted = await createPaypalInference(f);
  await restarted.cancel();
  assert.deepEqual(f.calls, ['create']);
});

void test('a failure to discard a token does not keep a completed session busy', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    discardApproval() {
      throw new Error('synthetic discard failure');
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  await session.create();
  await assert.rejects(session.approve('ORDER1'));
  assert.equal(session.status().phase, 'active');
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('a contradictory approval check blocks legacy inference across restart', async () => {
  const f = fixture();
  f.payment.isApproved = async () => {
    throw new Error('contradictory response');
  };
  const service = await createPaypalInference(f);
  await service.create('synthetic', 16);
  await assert.rejects(service.execute('ORDER1', 'synthetic', 16));
  await assert.rejects(service.cancel());
  await assert.rejects(service.create('another synthetic', 16));
  const restarted = await createPaypalInference(f);
  await assert.rejects(restarted.cancel());
  await assert.rejects(restarted.create('another synthetic', 16));
  await assert.rejects(restarted.execute('ORDER1', 'synthetic', 16));
  assert.deepEqual(f.calls, ['create']);
});

void test('failed writes before authorization never dispatch a payment', async () => {
  for (const phase of ['review', 'authorizing']) {
    for (const persisted of [false, true]) {
      const f = fixture();
      let checks = 0;
      f.payment.isApproved = async () => {
        checks += 1;
        return true;
      };
      const session = await createPaypalSession(f);
      await session.create();
      const write = f.journal.write;
      f.journal.write = async (value) => {
        if (
          value &&
          typeof value === 'object' &&
          'phase' in value &&
          value.phase === phase
        ) {
          if (persisted) await write(value);
          throw new Error('synthetic write failure');
        }
        await write(value);
      };
      await assert.rejects(session.approve('ORDER1'));
      assert.equal(checks, phase === 'review' ? 0 : 1);
      assert.deepEqual(f.calls, ['create']);
      const restarted = await createPaypalSession(f);
      assert.equal(
        restarted.status().phase,
        persisted ? phase : phase === 'review' ? 'created' : 'review',
      );
      if (restarted.status().phase !== 'created') {
        await assert.rejects(restarted.cancel('ORDER1'));
        await assert.rejects(restarted.create());
      }
    }
  }
});

void test('failed writes after an unapproved response cannot dispatch a payment', async () => {
  for (const persisted of [false, true]) {
    const f = fixture();
    f.payment.isApproved = async () => false;
    const session = await createPaypalSession(f);
    await session.create();
    const write = f.journal.write;
    f.journal.write = async (value) => {
      if (
        value &&
        typeof value === 'object' &&
        'phase' in value &&
        value.phase === 'created'
      ) {
        if (persisted) await write(value);
        throw new Error('synthetic write failure');
      }
      await write(value);
    };
    await assert.rejects(session.approve('ORDER1'));
    const restarted = await createPaypalSession(f);
    assert.equal(restarted.status().phase, persisted ? 'created' : 'review');
    assert.deepEqual(f.calls, ['create']);
  }
});

function sandboxVoidPayment(response: Response) {
  let voidCalls = 0;
  const fetchMock: typeof fetch = async (input) => {
    if (String(input).endsWith('/v1/oauth2/token'))
      return Response.json({ access_token: 'synthetic-token' });
    assert.equal(
      new URL(String(input)).pathname,
      '/v2/payments/authorizations/AUTH1/void',
    );
    voidCalls += 1;
    return response;
  };
  return {
    adapter: createPaypalSandbox({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      returnOrigin: 'http://127.0.0.1:8765',
      fetch: fetchMock,
    }),
    voidCalls: () => voidCalls,
  };
}

void test('a verified sandbox void settles the session without capture', async () => {
  const f = fixture();
  const sandbox = sandboxVoidPayment(
    Response.json({
      id: 'AUTH1',
      status: 'VOIDED',
      amount: { currency_code: 'USD', value: '1.00' },
    }),
  );
  const payment = { ...f.payment, void: sandbox.adapter.void };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create();
  await session.approve(order.orderId);
  await session.finish(order.orderId);
  const restarted = await createPaypalSession({ ...f, payment });
  assert.equal(restarted.status().phase, 'voided');
  assert.equal(sandbox.voidCalls(), 1);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('an unconfirmed sandbox void stays blocked after restart', async () => {
  for (const response of [
    Response.json({
      id: 'AUTH1',
      status: 'PENDING',
      amount: { currency_code: 'USD', value: '1.00' },
    }),
    new Response('SYNTHETIC_PRIVATE_MARKER', { status: 200 }),
  ]) {
    const f = fixture();
    const sandbox = sandboxVoidPayment(response);
    const payment = { ...f.payment, void: sandbox.adapter.void };
    const session = await createPaypalSession({ ...f, payment });
    const order = await session.create();
    await session.approve(order.orderId);
    await assert.rejects(session.finish(order.orderId));
    const restarted = await createPaypalSession({ ...f, payment });
    assert.equal(restarted.status().phase, 'voiding');
    await assert.rejects(restarted.finish(order.orderId));
    await assert.rejects(restarted.create());
    assert.equal(sandbox.voidCalls(), 1);
    assert.deepEqual(f.calls, ['create', 'authorize']);
  }
});

void test('an uncertain engine failure blocks settlement and further messages', async () => {
  const f = fixture();
  const session = await start(f);
  f.engine.generate = async () => {
    f.calls.push('generate');
    throw new Error('timeout');
  };
  await assert.rejects(session.message('ORDER1', 'one', 16, 'MESSAGE1'));
  await assert.rejects(session.finish('ORDER1'));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.message('ORDER1', 'two', 16, 'MESSAGE2'));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate']);
});

void test('a cancelled journal with inference attempts cannot unlock another order', async () => {
  const f = fixture();
  f.setState({
    version: 2,
    phase: 'cancelled',
    requestId: 'REQUEST1',
    currency: 'USD',
    limitCents: 100,
    messageCents: 10,
    maxMessageAttempts: 30,
    spentCents: 0,
    attemptIds: ['MESSAGE1'],
    acknowledgedIds: [],
    orderId: 'ORDER1',
  });
  await assert.rejects(createPaypalSession(f));
  assert.deepEqual(f.calls, []);
});

void test('old session messages and close requests cannot act on a new authorization', async () => {
  const f = fixture();
  let count = 0;
  f.payment.create = async () => {
    count += 1;
    f.calls.push('create');
    return {
      orderId: `ORDER${count}`,
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER${count}`,
    };
  };
  const session = await createPaypalSession(f);
  await session.create();
  await session.approve('ORDER1');
  await session.finish('ORDER1');
  await session.create();
  await assert.rejects(session.cancel('ORDER1'));
  await session.approve('ORDER2');
  await assert.rejects(session.message('ORDER1', 'late request', 16, 'STALE1'));
  await assert.rejects(session.finish('ORDER1'));
  const response = await session.message(
    'ORDER2',
    'new request',
    16,
    'MESSAGE2',
  );
  await assert.rejects(session.acknowledge('ORDER1', response.messageId));
  await session.acknowledge('ORDER2', response.messageId);
  await session.finish('ORDER2');
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'void',
    'create',
    'authorize',
    'generate',
    'capture:10',
  ]);
});

void test('a journal with altered price, limit or currency cannot resume', async () => {
  const f = fixture();
  await start(f);
  const value = f.getState();
  assert.ok(value && typeof value === 'object');
  assert.equal(Reflect.get(value, 'limitCents'), 100);
  assert.equal(Reflect.get(value, 'messageCents'), 10);
  assert.equal(Reflect.get(value, 'currency'), 'USD');
  for (const mutation of [
    { limitCents: 200 },
    { messageCents: 20 },
    { currency: 'EUR' },
  ]) {
    f.setState({ ...value, ...mutation });
    await assert.rejects(createPaypalSession(f));
  }
});

void test('a disconnect before engine dispatch preserves prior usage and does not generate', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', first.messageId);
  const controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (JSON.stringify(value).includes('executing')) controller.abort();
  };
  await assert.rejects(
    session.message('ORDER1', 'two', 16, 'MESSAGE2', controller.signal),
  );
  await assert.rejects(session.message('ORDER1', 'two', 16, 'MESSAGE2'));
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('old validated terminal terms permit a new session while changed active terms stay blocked', async () => {
  const f = fixture();
  const session = await start(f);
  const active = f.getState();
  assert.ok(active && typeof active === 'object');
  assert.equal(Reflect.get(active, 'maxMessageAttempts'), 30);
  f.setState({ ...active, maxMessageAttempts: 40 });
  await assert.rejects(createPaypalSession(f));
  f.setState(active);
  await session.finish('ORDER1');
  const closed = f.getState();
  assert.ok(closed && typeof closed === 'object');
  f.setState({
    ...closed,
    limitCents: 200,
    messageCents: 20,
    maxMessageAttempts: 40,
  });
  const restarted = await createPaypalSession(f);
  await restarted.create();
  assert.deepEqual(f.calls, ['create', 'authorize', 'void', 'create']);
});

void test('a captured session with earlier valid limits does not block a new order', async () => {
  const f = fixture();
  const session = await start(f);
  const response = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', response.messageId);
  await session.finish('ORDER1');
  const completed = f.getState();
  assert.ok(completed && typeof completed === 'object');
  f.setState({ ...completed, limitCents: 200, maxMessageAttempts: 40 });
  const restarted = await createPaypalSession(f);
  await restarted.create();
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'capture:10',
    'create',
  ]);
});
