// Synthetic response streams and private in-memory permissions exercise the real desktop client.
// No wallets, engines, existing profiles or external services are used.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectChatArchive,
  restoreChatArchive,
} from '@gyblos/desktop/chat-archive-model';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { MESSAGE_STATE } from '@gyblos/desktop/chat-state';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';

import { connect, latch, policy, setup, tick } from './support/desktop-stream';

void test('desktop streams visible text before its terminal and completes one verified free request', async () => {
  const value = setup();
  await connect(value);
  const progress: string[] = [];
  const pending = value.client.send(
    'stream-one',
    'Synthetic question',
    (text) => progress.push(text),
  );
  const settled = Promise.allSettled([pending]);
  try {
    await value.posted.promise;
    await tick();
    assert.deepEqual(progress, ['Hello']);
    assert.equal(JSON.parse(String(value.request()?.body)).stream, true);
    assert.equal((await value.budget.summary()).records.length, 0);
    value.finish();
    const result = await pending;
    assert.equal(result.text, 'Hello');
    assert.equal(result.summary.blocked, false);
    assert.equal(result.summary.records[0]?.free, true);
    assert.equal(value.posts(), 1);
  } finally {
    value.finish();
    await settled;
    await value.client.close();
  }
});
for (const maxAtomic of ['0', '100']) {
  void test(`desktop stop retains partial text without retry; authority ${maxAtomic}`, async () => {
    const value = setup(maxAtomic);
    await connect(value, maxAtomic);
    const progress: string[] = [];
    const pending = value.client.send(
      'stopped-one',
      'Synthetic question',
      (text) => progress.push(text),
    );
    const settled = Promise.allSettled([pending]);
    try {
      await value.posted.promise;
      await tick();
      assert.equal(value.client.stop('unrelated-request'), false);
      assert.equal(value.client.stop('stopped-one'), true);
      assert.equal(value.request()?.signal?.aborted, true);
      await assert.rejects(pending);
      assert.deepEqual(progress, ['Hello']);
      const summary = await new X402Budget(value.files).summary();
      assert.equal(summary.blocked, maxAtomic !== '0');
      assert.equal(summary.spentAtomic, '0');
      assert.deepEqual(summary.records, []);
      assert.equal(value.posts(), 1);
    } finally {
      value.finish();
      await settled;
      await value.client.close();
    }
  });
}
void test('desktop stop while reserving prevents the first prompt write', async () => {
  const reserved = latch();
  const release = latch();
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      if (JSON.parse(text).pending) {
        reserved.resolve();
        await release.promise;
      }
      saved = text;
    },
  });
  let posts = 0;
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    return Response.json({});
  });
  await client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-local-buyer-token',
  );
  await client.authorize('0');
  const pending = client.send(
    'held-reservation',
    'Synthetic question',
    () => {},
  );
  const settled = Promise.allSettled([pending]);
  try {
    await reserved.promise;
    client.stop('held-reservation');
    release.resolve();
    await assert.rejects(pending);
    assert.equal(posts, 0);
    assert.equal((await budget.summary()).blocked, false);
  } finally {
    release.resolve();
    await settled;
    await client.close();
  }
});
void test('desktop controller retains stopped partials and rejects late or cross-conversation updates', () => {
  const chat = new ChatController('first');
  const model = {
    id: 'synthetic',
    name: 'Synthetic',
    image: { src: 'synthetic.svg' },
    free: true,
  };
  chat.startPaypal(
    'Synthetic question',
    model,
    'turn-one',
    undefined,
    PAYMENT_METHOD.USDC,
  );
  chat.appendBuyer('first', 'turn-one', 'Hello');
  assert.equal(chat.getSnapshot().sessions[0]?.messages.at(-1)?.text, 'Hello');
  chat.stopBuyer('first', 'turn-one');
  chat.newChat('second');
  chat.startPaypal(
    'Another question',
    model,
    'turn-two',
    undefined,
    PAYMENT_METHOD.USDC,
  );
  chat.appendBuyer('first', 'turn-one', ' late');
  chat.completePaypal('first', 'turn-one', 'Late terminal', model);
  assert.equal(chat.getSnapshot().sessions[0]?.messages.at(-1)?.text, 'Hello');
  assert.equal(
    chat.getSnapshot().sessions[0]?.messages.at(-1)?.state,
    MESSAGE_STATE.STOPPED,
  );
  assert.equal(chat.getSnapshot().sessions[1]?.messages.at(-1)?.text, '');
});
void test('desktop pending partial survives archive restoration without resuming a request', () => {
  const chat = new ChatController('first');
  const model = {
    id: 'synthetic',
    name: 'Synthetic',
    image: { src: 'synthetic.svg' },
    free: true,
  };
  chat.startPaypal(
    'Synthetic question',
    model,
    'archive-one',
    undefined,
    PAYMENT_METHOD.USDC,
  );
  chat.appendBuyer('first', 'archive-one', 'Partial answer');
  const archive = projectChatArchive(chat.getSnapshot());
  assert.ok(archive);
  const restored = restoreChatArchive(archive);
  assert.equal(restored.sessions[0]?.messages.at(-1)?.text, 'Partial answer');
  assert.equal(
    restored.sessions[0]?.messages.at(-1)?.state,
    MESSAGE_STATE.STOPPED,
  );
  assert.equal(restored.sessions[0]?.paypalRun, null);
  assert.equal(restored.sessions[0]?.run, null);
});
void test('desktop zero-authority release refuses paid permissions and mismatched requests', async () => {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  for (const maxAtomic of ['0', '100']) {
    saved = undefined;
    const budget = new X402Budget(files);
    await budget.authorize({ ...policy, maxAtomic }, maxAtomic);
    await budget.reserve('held-one');
    const before = saved;
    await assert.rejects(() => budget.releaseFree('wrong-request'));
    assert.equal(saved, before);
    if (maxAtomic === '0') {
      await budget.releaseFree('held-one');
      assert.equal((await budget.summary()).blocked, false);
      assert.deepEqual((await budget.summary()).records, []);
    } else {
      await assert.rejects(() => budget.releaseFree('held-one'));
      assert.equal(saved, before);
      assert.equal((await new X402Budget(files).summary()).blocked, true);
    }
  }
});

void test('live activity follows the first nonempty delta and terminal for its own turn', () => {
  let clock = 10;
  const chat = new ChatController('first', undefined, () => clock);
  const model = {
    id: 'local',
    name: 'Local',
    image: { src: 'local.svg' },
    free: true,
  };
  const answer = () => chat.getSnapshot().sessions[0]?.messages.at(-1);
  chat.startPaypal('Question', model, 'one', undefined, PAYMENT_METHOD.USDC);
  assert.deepEqual(answer()?.activity, { started: 10 });
  clock = 15;
  chat.appendBuyer('first', 'one', '');
  chat.appendBuyer('first', 'other', 'wrong');
  assert.deepEqual(answer()?.activity, { started: 10 });
  clock = 20;
  chat.appendBuyer('first', 'one', 'Hello');
  clock = 24;
  chat.appendBuyer('first', 'one', ' world');
  chat.stopBuyer('first', 'one');
  clock = 99;
  chat.failPaypal('first', 'one', 'late');
  assert.deepEqual(answer()?.activity, { started: 10, first: 20, ended: 24 });
  const archive = projectChatArchive(chat.getSnapshot());
  assert.ok(archive);
  assert.equal(archive.sessions[0]?.messages.at(-1)?.text, 'Hello world');
  assert.ok(!JSON.stringify(archive).includes('activity'));
  chat.startPaypal('Question', model, 'two');
  chat.completePaypal('first', 'two', 'Answer', model);
  assert.deepEqual(answer()?.activity, { started: 99, ended: 99 });
  chat.startPaypal('Question', model, 'three');
  clock = 101;
  chat.failPaypal('first', 'three', 'Unavailable');
  assert.deepEqual(answer()?.activity, { started: 99, ended: 101 });
});
