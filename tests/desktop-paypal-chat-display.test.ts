// Tests chat presentation state using in-memory payment and inference fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

async function setup() {
  const f = fixture();
  const service = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
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
  return {
    f,
    chat: new PaypalChatController((request) => handlers.run(event, [request])),
  };
}

void test('a chosen session limit reaches the sandbox order from chat', async () => {
  const f = fixture();
  let sentLimit = 0;
  const payment = {
    ...f.payment,
    async create(
      _requestId: string,
      _returnState?: string,
      limitCents?: number,
    ) {
      sentLimit = limitCents ?? 0;
      return f.payment.create();
    },
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession({ ...f, payment }),
    async () => {},
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'qwen-test' }),
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const chat = new PaypalChatController((request) =>
    handlers.run({ sender: contents, senderFrame: frame }, [request]),
  );
  await chat.refresh();
  await chat.startCheckout(500);
  await chat.approve();
  assert.equal(sentLimit, 500);
  assert.equal(chat.getSnapshot().status?.limitCents, 500);
  assert.equal(chat.getSnapshot().status?.phase, 'active');
});

void test('a void check explains what PayPal confirmed without closing or charging', async () => {
  const f = fixture();
  const payment = {
    ...f.payment,
    async void() {
      f.calls.push('void');
      throw new Error('lost response');
    },
    async checkVoidedAuthorization() {
      f.calls.push('check void');
    },
  };
  const node = await createPaypalSession({
    ...f,
    payment,
    journal: { ...f.journal, claimSession: () => f.journal },
  });
  const order = await node.create();
  await node.approve(order.orderId);
  await assert.rejects(node.finish(order.orderId));
  const service = createDesktopPaypalSession(node, async () => {});
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'qwen-test' }),
    { contents, mainFrame: () => frame, destroyed: () => false },
  );
  const chat = new PaypalChatController((request) =>
    handlers.run({ sender: contents, senderFrame: frame }, [request]),
  );
  await chat.refresh();
  await chat.checkVoidedAuthorization();
  assert.equal(chat.getSnapshot().status?.phase, 'voiding');
  assert.match(chat.getSnapshot().notice, /authorization.*voided/i);
  assert.match(chat.getSnapshot().notice, /payment history.*not verified/i);
  assert.deepEqual(f.calls, ['create', 'authorize', 'void', 'check void']);
});

void test('a void check never claims confirmation when its result has no session status', async () => {
  const chat = new PaypalChatController(async () => ({
    status: null,
    model: null,
    answer: null,
    error: null,
  }));
  await chat.checkVoidedAuthorization();
  assert.doesNotMatch(chat.getSnapshot().notice, /PayPal confirms/);
  assert.match(chat.getSnapshot().notice, /could not confirm/i);
});

void test('a submitted prompt remains visible while the response is generating', async () => {
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
  const sending = chat.send();
  try {
    assert.equal(chat.getSnapshot().pendingPrompt, 'First prompt');
    assert.equal(chat.getSnapshot().draft, '');
    assert.deepEqual(chat.getSnapshot().messages, []);
    chat.setDraft('First prompt');
    assert.equal(chat.getSnapshot().pendingPrompt, 'First prompt');
  } finally {
    release?.();
    await sending;
  }
  assert.equal(chat.getSnapshot().pendingPrompt, null);
  assert.equal(chat.getSnapshot().draft, 'First prompt');
  assert.deepEqual(
    chat.getSnapshot().messages.map((message) => message.text),
    ['First prompt', 'a synthetic answer'],
  );
});

void test('failed inference clears the loading state and preserves the draft', async () => {
  const { f, chat } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.engine.generate = async () => {
    await wait;
    throw new Error('synthetic engine failure');
  };
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('Keep this draft');
  const sending = chat.send();
  try {
    assert.equal(chat.getSnapshot().pendingPrompt, 'Keep this draft');
  } finally {
    release?.();
    await sending;
  }
  assert.equal(chat.getSnapshot().pendingPrompt, null);
  assert.equal(chat.getSnapshot().draft, 'Keep this draft');
  assert.deepEqual(chat.getSnapshot().messages, []);
  assert.equal(chat.getSnapshot().status?.phase, 'executing');
});

void test('new messages follow the bottom while intentional scrolling is respected', async () => {
  const { PaypalChatScroll } = await import('@gyblos/desktop/paypal-chat');
  const scroll = new PaypalChatScroll();
  const viewport = { scrollTop: 280, clientHeight: 200, scrollHeight: 500 };
  assert.equal(scroll.observe(viewport), true);
  viewport.scrollHeight = 800;
  scroll.follow(viewport);
  assert.equal(viewport.scrollTop, 800);
  viewport.scrollTop = 200;
  assert.equal(scroll.observe(viewport), false);
  viewport.scrollHeight = 1000;
  scroll.follow(viewport);
  assert.equal(viewport.scrollTop, 200);
  scroll.latest(viewport);
  assert.equal(viewport.scrollTop, 1000);
  viewport.scrollHeight = 1200;
  scroll.follow(viewport);
  assert.equal(viewport.scrollTop, 1200);
});
