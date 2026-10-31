import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture, start } from './support/paypal-session-fixture';

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
