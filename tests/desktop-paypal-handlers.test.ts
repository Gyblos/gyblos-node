// Verifies the desktop IPC boundary with synthetic payment and inference dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

async function setup(
  confirmFinish: (summary: {
    spentCents: number;
    limitCents: number;
  }) => Promise<boolean> = async () => false,
) {
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
    async () => false,
    confirmFinish,
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

void test('settlement requires a host confirmation of the actual recorded amount', async () => {
  const seen: { spentCents: number; limitCents: number }[] = [];
  const { f, handlers, event } = await setup(async (summary) => {
    seen.push(summary);
    return true;
  });
  await handlers.run(event, [{ action: 'create' }]);
  await handlers.run(event, [{ action: 'approve' }]);
  const answer = await handlers.run(event, [
    { action: 'send', prompt: 'Question' },
  ]);
  await handlers.run(event, [
    { action: 'acknowledge', messageId: answer.answer?.messageId },
  ]);
  const result = await handlers.run(event, [{ action: 'finish' }]);
  assert.deepEqual(seen, [{ spentCents: 10, limitCents: 100 }]);
  assert.equal(result.status?.phase, 'completed');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('cancelling settlement leaves the session and provider untouched', async () => {
  const { f, handlers, event } = await setup();
  await handlers.run(event, [{ action: 'create' }]);
  await handlers.run(event, [{ action: 'approve' }]);
  const result = await handlers.run(event, [{ action: 'finish' }]);
  assert.equal(result.status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('an unused authorization is voided only after confirmation', async () => {
  const seen: { spentCents: number; limitCents: number }[] = [];
  const { f, handlers, event } = await setup(async (summary) => {
    seen.push(summary);
    return true;
  });
  await handlers.run(event, [{ action: 'create' }]);
  await handlers.run(event, [{ action: 'approve' }]);
  const result = await handlers.run(event, [{ action: 'finish' }]);
  assert.deepEqual(seen, [{ spentCents: 0, limitCents: 100 }]);
  assert.equal(result.status?.phase, 'voided');
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('the reviewed amount cannot change while confirmation is open', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { f, service, handlers, event } = await setup(async () => {
    entered?.();
    await waiting;
    return false;
  });
  await handlers.run(event, [{ action: 'create' }]);
  await handlers.run(event, [{ action: 'approve' }]);
  const finishing = handlers.run(event, [{ action: 'finish' }]);
  await started;
  try {
    await assert.rejects(service.send('A concurrent request'));
    await assert.rejects(service.prepareAgent());
  } finally {
    release?.();
  }
  const result = await finishing;
  assert.equal(result.status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
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
