// Tests the real desktop chat coordinator against synthetic sandbox services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { validatePaypalPrompt } from '@gyblos/node/paypal-startup';

import { fixture } from './support/paypal-session-fixture';

async function setup() {
  const f = fixture();
  const opened: string[] = [];
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, validateRequest: validatePaypalPrompt }),
    async (url) => {
      opened.push(url);
    },
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'qwen-test' }),
    {
      contents,
      mainFrame: () => frame,
      destroyed: () => false,
    },
  );
  const event = { sender: contents, senderFrame: frame };
  const run = (request: unknown) => handlers.run(event, [request]);
  return { f, opened, run, chat: new PaypalChatController(run) };
}

void test('desktop chat completes two real service responses with a single approval', async () => {
  const { f, opened, chat } = await setup();
  await chat.refresh();
  assert.equal(chat.getSnapshot().status?.phase, 'ready');
  assert.deepEqual(f.calls, []);
  await chat.create();
  assert.equal(chat.getSnapshot().status?.phase, 'created');
  await chat.openApproval();
  assert.equal(opened.length, 1);
  await chat.approve();
  chat.setDraft('First prompt');
  await chat.send();
  assert.equal(chat.getSnapshot().status?.spentCents, 10);
  chat.setDraft('Second prompt');
  await chat.send();
  const beforeClose = chat.getSnapshot();
  assert.equal(beforeClose.status?.spentCents, 20);
  assert.equal(beforeClose.model, 'qwen-test');
  assert.deepEqual(
    beforeClose.messages.map((message) => message.text),
    [
      'First prompt',
      'a synthetic answer',
      'Second prompt',
      'a synthetic answer',
    ],
  );
  await chat.finish();
  assert.equal(chat.getSnapshot().status?.phase, 'completed');
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:20',
  ]);
});

void test('an inference failure keeps the draft and never substitutes a synthetic response', async () => {
  const { f, chat } = await setup();
  f.engine.generate = async () => {
    throw new Error('synthetic engine failure');
  };
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('Keep this draft');
  await chat.send();
  assert.equal(chat.getSnapshot().draft, 'Keep this draft');
  assert.deepEqual(chat.getSnapshot().messages, []);
  assert.equal(chat.getSnapshot().status?.phase, 'executing');
  assert.match(chat.getSnapshot().notice, /check|reconcil/i);
  await chat.send();
  await chat.finish();
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a lost acknowledgement response can retry only the acknowledgement', async () => {
  const { f, run } = await setup();
  let drop = true;
  const chat = new PaypalChatController(async (request) => {
    const result = await run(request);
    if (request.action === 'acknowledge' && drop) {
      drop = false;
      throw new Error('synthetic lost response');
    }
    return result;
  });
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('One prompt');
  await chat.send();
  assert.equal(chat.getSnapshot().messages.length, 2);
  assert.ok(chat.getSnapshot().pendingMessageId);
  await chat.retryAcknowledgement();
  assert.equal(chat.getSnapshot().pendingMessageId, null);
  assert.equal(chat.getSnapshot().status?.spentCents, 10);
  await chat.finish();
  assert.equal(f.calls.filter((call) => call === 'generate').length, 1);
  assert.equal(f.calls.filter((call) => call === 'capture:10').length, 1);
});

void test('a second click cannot create a parallel order', async () => {
  const { f, run } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new PaypalChatController(async (request) => {
    if (request.action === 'create') await wait;
    return run(request);
  });
  await chat.refresh();
  const first = chat.create();
  await chat.create();
  assert.ok(release);
  release();
  await first;
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
});

void test('a follow-up draft typed during inference is preserved', async () => {
  const { f, chat } = await setup();
  const generate = f.engine.generate;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.engine.generate = async () => {
    await wait;
    return generate();
  };
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('First prompt');
  const pending = chat.send();
  chat.setDraft('Follow-up draft');
  assert.ok(release);
  release();
  await pending;
  assert.equal(chat.getSnapshot().draft, 'Follow-up draft');
  assert.equal(chat.getSnapshot().status?.spentCents, 10);
});

void test('a valid long response is acknowledged rather than lost by the desktop boundary', async () => {
  const { f, chat } = await setup();
  const text = 'x'.repeat(70_000);
  f.engine.generate = async () => ({
    text,
    usage: { inputTokens: 2, outputTokens: 3 },
  });
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('Long response');
  await chat.send();
  assert.equal(chat.getSnapshot().messages.at(-1)?.text, text);
  assert.equal(chat.getSnapshot().status?.spentCents, 10);
  assert.equal(chat.getSnapshot().pendingMessageId, null);
});

void test('a new sandbox session starts with an empty transcript after settlement', async () => {
  const { chat } = await setup();
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('First session');
  await chat.send();
  await chat.finish();
  assert.equal(chat.getSnapshot().messages.length, 2);
  await chat.create();
  assert.equal(chat.getSnapshot().status?.phase, 'created');
  assert.deepEqual(chat.getSnapshot().messages, []);
});

void test('an invalid prompt keeps the session usable and explains how to fix it', async () => {
  const { f, chat } = await setup();
  await chat.refresh();
  await chat.create();
  await chat.approve();
  const draft = 'x'.repeat(3000);
  chat.setDraft(draft);
  await chat.send();
  assert.equal(chat.getSnapshot().draft, draft);
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.match(chat.getSnapshot().notice, /shorten|shorter/i);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});
