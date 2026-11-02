// Exercises the desktop boundary against the existing sandbox session with synthetic dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

async function setup() {
  const f = fixture();
  const opened: string[] = [];
  const session = await createPaypalSession(f);
  const desktop = createDesktopPaypalSession(session, async (url) => {
    opened.push(url);
  });
  return { f, opened, desktop };
}

void test('creating a session keeps the approval link in the host', async () => {
  const { f, opened, desktop } = await setup();
  assert.equal(desktop.status().phase, 'ready');
  const created = await desktop.create();
  assert.equal(created.phase, 'created');
  assert.deepEqual(Object.keys(created).sort(), [
    'expired',
    'limitCents',
    'messageCents',
    'phase',
    'remainingAttempts',
    'spentCents',
  ]);
  assert.deepEqual(opened, []);
  await desktop.openApproval();
  assert.equal(opened.length, 1);
  assert.deepEqual(f.calls, ['create']);
});

void test('approval is checked by PayPal before an authorization is made', async () => {
  const { f, desktop } = await setup();
  f.payment.isApproved = async () => false;
  await desktop.create();
  await assert.rejects(desktop.approve());
  assert.equal(desktop.status().phase, 'created');
  assert.deepEqual(f.calls, ['create']);
});

void test('one approval covers two acknowledged answers and one partial capture', async () => {
  const { f, desktop } = await setup();
  await desktop.create();
  await desktop.approve();
  const first = await desktop.send('First question');
  assert.equal(first.text, 'a synthetic answer');
  assert.equal(desktop.status().phase, 'message_pending');
  await desktop.acknowledge(first.messageId);
  const second = await desktop.send('Second question');
  await desktop.acknowledge(second.messageId);
  const done = await desktop.finish();
  assert.equal(done.phase, 'completed');
  assert.equal(done.spentCents, 20);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:20',
  ]);
});

void test('an unacknowledged response blocks another message and settlement', async () => {
  const { f, desktop } = await setup();
  await desktop.create();
  await desktop.approve();
  const answer = await desktop.send('One question');
  await assert.rejects(desktop.send('Another question'));
  await assert.rejects(desktop.finish());
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate']);
  await desktop.acknowledge(answer.messageId);
  assert.equal(desktop.status().spentCents, 10);
});

void test('closing without acknowledged use voids the authorization', async () => {
  const { f, desktop } = await setup();
  await desktop.create();
  await desktop.approve();
  assert.equal((await desktop.finish()).phase, 'voided');
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('an uncertain capture blocks retries and new orders', async () => {
  const { f, desktop } = await setup();
  f.payment.capture = async () => {
    f.calls.push('uncertain capture');
    throw new Error('synthetic transport failure');
  };
  await desktop.create();
  await desktop.approve();
  const answer = await desktop.send('One question');
  await desktop.acknowledge(answer.messageId);
  await assert.rejects(desktop.finish());
  assert.equal(desktop.status().phase, 'capturing');
  await assert.rejects(desktop.finish());
  await assert.rejects(desktop.create());
  assert.equal(
    f.calls.filter((call) => call === 'uncertain capture').length,
    1,
  );
});

void test('the host refuses approval links outside PayPal Sandbox', async () => {
  const { f, opened, desktop } = await setup();
  f.payment.create = async () => ({
    orderId: 'ORDER1',
    approvalUrl: 'https://example.com/checkout',
  });
  await desktop.create();
  await assert.rejects(desktop.openApproval());
  assert.deepEqual(opened, []);
});

void test('a restarted unapproved order cannot silently create a second order', async () => {
  const { f, desktop } = await setup();
  await desktop.create();
  const resumed = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  assert.equal(resumed.status().phase, 'created');
  await assert.rejects(resumed.openApproval());
  await assert.rejects(resumed.create());
  assert.deepEqual(f.calls, ['create']);
});
