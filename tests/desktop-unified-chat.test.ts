// Runs the unified transcript with synthetic payment/engine services only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatController } from '@gyblos/desktop/chat-controller';
import { sendPaypalMessage } from '@gyblos/desktop/chat-paypal';
import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import {
  PAYMENT_METHOD,
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
} from '@gyblos/desktop/paypal-model';
import {
  RESPONSE_COST_KIND,
  RESPONSE_COST_UNIT,
} from '@gyblos/desktop/response-metrics';

import { setup } from './support/desktop-paypal-chat-fixture';

void test('sending from the unified chat uses one approved session and keeps the next draft', async () => {
  const { chat: paypal, f } = await setup();
  await paypal.refresh();
  await paypal.create();
  await paypal.approve();
  const chat = new ChatController('one');
  chat.setDraft('First');
  const pending = sendPaypalMessage(chat, paypal, 'first');
  chat.setDraft('Next draft');
  await pending;
  assert.equal(chat.getSnapshot().sessions[0]?.draft, 'Next draft');
  chat.setDraft('Second');
  await sendPaypalMessage(chat, paypal, 'second');
  assert.equal(f.calls.filter((call) => call === 'authorize').length, 1);
  assert.equal(paypal.getSnapshot().status?.spentCents, 20);
  const messages = chat.getSnapshot().sessions[0]!.messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.paymentMethod, PAYMENT_METHOD.PAYPAL);
  assert.equal(messages[1]?.model.name, 'qwen-test');
});

void test('an unavailable PayPal session leaves the shared draft and transcript untouched', async () => {
  const { chat: paypal, f } = await setup();
  const chat = new ChatController('one');
  chat.setDraft('Keep this');
  assert.equal(await sendPaypalMessage(chat, paypal, 'blocked'), false);
  assert.equal(chat.getSnapshot().sessions[0]?.draft, 'Keep this');
  assert.deepEqual(chat.getSnapshot().sessions[0]?.messages, []);
  assert.deepEqual(f.calls, []);
});

void test('a received response stays visible when acknowledgement fails and cannot be sent twice', async () => {
  const { run } = await setup();
  const paypal = new PaypalChatController(async (request) =>
    request.action === PAYPAL_ACTION.ACKNOWLEDGE
      ? {
          status: null,
          model: null,
          answer: null,
          error: PAYPAL_DESKTOP_ERROR.UNAVAILABLE,
        }
      : run(request),
  );
  await paypal.refresh();
  await paypal.create();
  await paypal.approve();
  const chat = new ChatController('one');
  chat.setDraft('First');
  await sendPaypalMessage(chat, paypal, 'first');
  assert.equal(
    chat.getSnapshot().sessions[0]?.messages.at(-1)?.text,
    'a synthetic answer',
  );
  assert.ok(paypal.getSnapshot().pendingMessageId);
  assert.deepEqual(
    chat.getSnapshot().sessions[0]?.messages.at(-1)?.metrics?.cost,
    {
      amount: '0.10',
      unit: RESPONSE_COST_UNIT.USD,
      kind: RESPONSE_COST_KIND.RECORDED,
    },
  );
  chat.setDraft('Do not send');
  assert.equal(await sendPaypalMessage(chat, paypal, 'blocked'), false);
  assert.equal(chat.getSnapshot().sessions[0]?.messages.length, 2);
});

void test('received text appears before delayed acknowledgement and another send remains blocked', async () => {
  const { run } = await setup();
  let now = 100;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paypal = new PaypalChatController(async (request) => {
    if (request.action === PAYPAL_ACTION.ACKNOWLEDGE) await wait;
    const result = await run(request);
    if (request.action === PAYPAL_ACTION.SEND) now = 1334;
    return result;
  });
  await paypal.refresh();
  await paypal.create();
  await paypal.approve();
  const chat = new ChatController('one');
  chat.setDraft('First');
  const pending = sendPaypalMessage(
    chat,
    paypal,
    'first',
    undefined,
    () => now,
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.text,
      'a synthetic answer',
    );
    assert.equal(paypal.getSnapshot().busy, true);
    assert.ok(paypal.getSnapshot().pendingMessageId);
    assert.deepEqual(chat.getSnapshot().sessions[0]?.messages.at(-1)?.metrics, {
      inputTokens: null,
      outputTokens: null,
      firstTokenMs: null,
      generationMs: null,
      responseMs: 1234,
      cost: {
        amount: '0.10',
        unit: RESPONSE_COST_UNIT.USD,
        kind: RESPONSE_COST_KIND.RECORDED,
      },
    });
    now = 5000;
    chat.setDraft('Next draft');
    assert.equal(await sendPaypalMessage(chat, paypal, 'blocked'), false);
  } finally {
    release?.();
    await pending;
  }
  assert.equal(chat.getSnapshot().sessions[0]?.draft, 'Next draft');
  assert.equal(paypal.getSnapshot().pendingMessageId, null);
});
