import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('a void check requires ownership of an exclusive journal', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async void() {
      throw new Error('lost');
    },
    async checkVoidedAuthorization() {
      f.calls.push('check void');
    },
  };
  const session = await createPaypalSession({ ...f, payment });
  const order = await session.create();
  await session.approve(order.orderId);
  await assert.rejects(session.finish(order.orderId));
  await assert.rejects(session.checkVoidedAuthorization());
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a void check rejects a lost journal lock and releases its busy state', async () => {
  const f = fixture();
  let failRead = false;
  const journal = {
    ...f.journal,
    async read() {
      if (failRead) throw new Error('lost synthetic lock');
      return f.journal.read();
    },
  };
  const payment = {
    ...f.payment,
    async void() {
      throw new Error('lost response');
    },
    async checkVoidedAuthorization() {
      failRead = true;
    },
  };
  const session = await createPaypalSession({
    ...f,
    payment,
    journal: { ...journal, claimSession: () => journal },
  });
  const order = await session.create();
  await session.approve(order.orderId);
  await assert.rejects(session.finish(order.orderId));
  await assert.rejects(session.checkVoidedAuthorization());
  assert.equal(session.status().phase, 'voiding');
});

void test('checking an interrupted void does not change the session or repeat a payment', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async void() {
      f.calls.push('void');
      throw new Error('synthetic lost response');
    },
    async checkVoidedAuthorization(
      orderId: string,
      _requestId: string,
      authorizationId: string,
    ) {
      assert.equal(orderId, 'ORDER1');
      assert.equal(authorizationId, 'AUTH1');
      f.calls.push('check void');
    },
  };
  const session = await createPaypalSession({
    ...f,
    payment,
    journal: { ...f.journal, claimSession: () => f.journal },
  });
  const created = await session.create();
  await session.approve(created.orderId);
  await assert.rejects(session.finish(created.orderId));
  const before = structuredClone(f.getState());
  await session.checkVoidedAuthorization();
  assert.deepEqual(f.getState(), before);
  assert.equal(session.status().phase, 'voiding');
  await assert.rejects(session.create());
  assert.deepEqual(f.calls, ['create', 'authorize', 'void', 'check void']);
});

void test('a void check rejects a changed durable session during the provider check', async () => {
  const f = fixture();
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const payment = {
    ...f.payment,
    async void() {
      throw new Error('lost');
    },
    async checkVoidedAuthorization() {
      entered();
      await paused;
    },
  };
  const session = await createPaypalSession({
    ...f,
    payment,
    journal: { ...f.journal, claimSession: () => f.journal },
  });
  const created = await session.create();
  await session.approve(created.orderId);
  await assert.rejects(session.finish(created.orderId));
  const before = f.getState();
  assert.ok(before && typeof before === 'object');
  const pending = session.checkVoidedAuthorization();
  await reached;
  f.setState({ ...before, phase: 'voided' });
  resume();
  await assert.rejects(pending);
  assert.equal(session.status().phase, 'voiding');
});
