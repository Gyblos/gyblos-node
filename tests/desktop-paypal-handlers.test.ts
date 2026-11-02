// Verifies the desktop IPC boundary with synthetic payment and inference dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

async function setup() {
  const f = fixture();
  const opened: string[] = [];
  const service = createDesktopPaypalSession(
    await createPaypalSession(f),
    async (url) => {
      opened.push(url);
    },
  );
  const contents = {};
  const frame = {};
  let loads = 0;
  const handlers = createDesktopPaypalHandlers(
    async () => {
      loads++;
      return { service, model: 'synthetic-model' };
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  return {
    f,
    opened,
    service,
    handlers,
    event: { sender: contents, senderFrame: frame },
    loads: () => loads,
  };
}

void test('only the owning main frame can invoke sandbox operations', async () => {
  const { f, handlers, event, loads } = await setup();
  assert.equal(
    (await handlers.run({ ...event, sender: {} }, [{ action: 'create' }]))
      .error,
    'denied',
  );
  assert.equal(
    (await handlers.run({ ...event, senderFrame: {} }, [{ action: 'create' }]))
      .error,
    'denied',
  );
  assert.equal(
    (await handlers.run(event, [{ action: 'create' }, {}])).error,
    'denied',
  );
  assert.equal(loads(), 0);
  assert.deepEqual(f.calls, []);
});

void test('malformed requests are rejected before starting the service', async () => {
  const { handlers, event, loads } = await setup();
  for (const request of [
    null,
    { action: 'create', extra: true },
    { action: 'send', prompt: '' },
    { action: 'send', prompt: 'x'.repeat(9000) },
    { action: 'acknowledge', messageId: 42 },
    { action: 'unknown' },
  ]) {
    assert.equal((await handlers.run(event, [request])).error, 'invalid');
  }
  assert.equal(loads(), 0);
});

void test('the renderer receives status and answers without order or approval details', async () => {
  const { f, handlers, event } = await setup();
  const initial = await handlers.run(event, [{ action: 'status' }]);
  assert.equal(initial.status?.phase, 'ready');
  assert.equal(initial.model, 'synthetic-model');
  const created = await handlers.run(event, [{ action: 'create' }]);
  assert.equal(created.status?.phase, 'created');
  assert.doesNotMatch(
    JSON.stringify(created),
    /ORDER1|checkoutnow|sandbox\.paypal\.com/,
  );
  await handlers.run(event, [{ action: 'approve' }]);
  const answer = await handlers.run(event, [
    { action: 'send', prompt: 'Question' },
  ]);
  assert.equal(answer.answer?.text, 'a synthetic answer');
  assert.equal(answer.status?.phase, 'message_pending');
  assert.doesNotMatch(JSON.stringify(answer), /ORDER1|AUTH1/);
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate']);
});

void test('payment failures return sanitized errors and preserve uncertain state', async () => {
  const { f, handlers, event } = await setup();
  f.engine.generate = async () => {
    throw new Error('private synthetic diagnostic');
  };
  await handlers.run(event, [{ action: 'create' }]);
  await handlers.run(event, [{ action: 'approve' }]);
  const failed = await handlers.run(event, [
    { action: 'send', prompt: 'Question' },
  ]);
  assert.equal(failed.error, 'failed');
  assert.equal(failed.status?.phase, 'executing');
  assert.doesNotMatch(
    JSON.stringify(failed),
    /private synthetic diagnostic|Question|ORDER1/,
  );
});
