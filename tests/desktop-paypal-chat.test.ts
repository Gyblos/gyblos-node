// Tests the real desktop chat coordinator against synthetic sandbox services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { PAYPAL_DESKTOP_ERROR } from '@gyblos/desktop/paypal-model';

import { setup } from './support/desktop-paypal-chat-fixture';

void test('cancelling the close confirmation clearly leaves the session open', async () => {
  const { f, chat } = await setup(false);
  await chat.refresh();
  await chat.create();
  await chat.approve();
  await chat.finish();
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.match(chat.getSnapshot().notice, /session remains open/i);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a failed status poll marks the last known session as stale until refreshed', async () => {
  const { f, run } = await setup();
  let unavailable = false;
  const chat = new PaypalChatController(async (request) => {
    if (unavailable && request.action === 'status') throw new Error('offline');
    return run(request);
  });
  await chat.refresh();
  await chat.create();
  await chat.approve();
  assert.equal(chat.getSnapshot().statusFresh, true);
  unavailable = true;
  await chat.poll();
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.equal(chat.getSnapshot().statusFresh, false);
  chat.setDraft('Hello');
  await chat.send();
  await chat.finish();
  assert.deepEqual(chat.getSnapshot().messages, []);
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
  unavailable = false;
  await chat.poll();
  assert.equal(chat.getSnapshot().statusFresh, true);
});

void test('the buyer starts checkout once and the verified return starts the session', async () => {
  const { f, opened, service, states, chat } = await setup();
  await chat.refresh();
  await chat.startCheckout();
  assert.equal(opened.length, 1);
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await chat.returnedFromPaypal();
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a return arriving during browser opening is processed once afterward', async () => {
  const { f, run, service, states } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new PaypalChatController(async (request) => {
    const result = await run(request);
    if (request.action === 'open') await wait;
    return result;
  });
  await chat.refresh();
  await chat.create();
  const opening = chat.openApproval();
  await new Promise((resolve) => setImmediate(resolve));
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await chat.returnedFromPaypal();
  await chat.returnedFromPaypal();
  assert.ok(release);
  release();
  await opening;
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('a valid approval arriving while an old cancellation notice is checked is not lost', async () => {
  const { f, run, service, states } = await setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new PaypalChatController(async (request) => {
    if (request.action === 'complete-cancel') await wait;
    return run(request);
  });
  await chat.refresh();
  await chat.startCheckout();
  const oldState = states[0];
  assert.ok(oldState);
  assert.equal(
    service.noteCancelledReturn({ state: oldState, token: 'ORDER1' }),
    true,
  );
  await chat.abandon();
  await chat.startCheckout();
  const cancelling = chat.cancelledFromPaypal();
  const state = states[1];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await chat.returnedFromPaypal();
  assert.ok(release);
  release();
  await cancelling;
  assert.equal(chat.getSnapshot().status?.phase, 'active');
  assert.deepEqual(f.calls, ['create', 'create', 'authorize']);
});

void test('an ambiguous manual approval does not dispatch a queued automatic check', async () => {
  const { f, run, service, states } = await setup();
  let release: (() => void) | undefined;
  let automaticChecks = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.payment.isApproved = async () => {
    await wait;
    throw new Error('synthetic timeout');
  };
  const chat = new PaypalChatController(async (request) => {
    if (request.action === 'complete-return') automaticChecks += 1;
    return run(request);
  });
  await chat.refresh();
  await chat.startCheckout();
  const checking = chat.approve();
  const state = states[0];
  assert.ok(state);
  assert.equal(service.noteApprovedReturn({ state, token: 'ORDER1' }), true);
  await chat.returnedFromPaypal();
  assert.ok(release);
  release();
  await checking;
  assert.equal(automaticChecks, 0);
  assert.deepEqual(f.calls, ['create']);
});

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

void test('an expired session does not blame a valid prompt', async () => {
  const { run } = await setup();
  const chat = new PaypalChatController(async (request) => {
    if (request.action !== 'send') return run(request);
    const result = await run({ action: 'status' });
    assert.ok(result.status);
    return {
      ...result,
      status: { ...result.status, expired: true },
      error: PAYPAL_DESKTOP_ERROR.INVALID_PROMPT,
    };
  });
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('A valid prompt');
  await chat.send();
  assert.match(chat.getSnapshot().notice, /expired/i);
  assert.equal(chat.getSnapshot().draft, 'A valid prompt');
});

void test('background status updates show external usage without blocking the composer', async () => {
  const { run } = await setup();
  let externalSpent = 0;
  const chat = new PaypalChatController(async (request) => {
    const result = await run(request);
    if (request.action === 'status' && result.status)
      return {
        ...result,
        status: { ...result.status, spentCents: externalSpent },
      };
    return result;
  });
  await chat.refresh();
  await chat.create();
  await chat.approve();
  chat.setDraft('Keep typing');
  externalSpent = 20;
  await chat.poll();
  assert.equal(chat.getSnapshot().status?.spentCents, 20);
  assert.equal(chat.getSnapshot().draft, 'Keep typing');
  assert.equal(chat.getSnapshot().busy, false);
});
