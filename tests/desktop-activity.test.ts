// Exercises activity projections and private history using synthetic sessions only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { desktopActivityPaths } from '@gyblos/config/home';
import { createActivityHandlers } from '@gyblos/desktop/activity-handlers';
import { ActivityHistory } from '@gyblos/desktop/activity-history';
import { parseActivityResult } from '@gyblos/desktop/activity-model';
import { ActivityObserver } from '@gyblos/desktop/activity-observer';
import { createDesktopActivityStorage } from '@gyblos/desktop/activity-storage';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { conversationSummary } from '@gyblos/desktop/chat-history';
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture, start } from './support/paypal-session-fixture';

void test('activity separates acknowledged Chat usage from unfinished delivery and captures', async () => {
  const f = fixture();
  const session = await start(f);
  const before = [...f.calls];
  const initial = session.activity();
  assert.equal(initial?.recordedCents, 0);
  assert.equal(initial?.capturedCents, null);
  assert.match(initial!.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls, before);
  const answer = await session.message(
    'ORDER1',
    'Private prompt',
    16,
    'MESSAGE1',
  );
  const pending = session.activity()!;
  assert.equal(pending.recordedCents, 10);
  assert.equal(pending.chatCents, 0);
  assert.equal(pending.unconfirmedCents, 10);
  await session.acknowledge('ORDER1', answer.messageId);
  assert.equal(session.activity()?.chatCents, 10);
  assert.equal(session.activity()?.capturedCents, null);
  await session.finish('ORDER1');
  assert.equal(session.activity()?.capturedCents, 10);
  assert.equal(session.activity()?.id, initial?.id);
  assert.doesNotMatch(
    JSON.stringify(session.activity()),
    /ORDER1|AUTH1|MESSAGE1|Private prompt|captureId|requestId/,
  );
});

void test('uncertain capture stays unconfirmed and a blocked journal hides capture claims', async () => {
  const f = fixture();
  const session = await start(f);
  const answer = await session.message('ORDER1', 'Question', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', answer.messageId);
  f.payment.capture = async () => {
    throw new Error('network');
  };
  await assert.rejects(session.finish('ORDER1'));
  assert.equal(session.activity()?.capturedCents, null);
  assert.equal(session.activity()?.needsReview, true);
});

void test('history preserves multiple sessions, updates by id and survives reload without payment calls', async () => {
  const f = fixture();
  const session = await start(f);
  let text: string | undefined;
  const files = {
    read: async () => text,
    write: async (value: string) => {
      text = value;
    },
  };
  const history = new ActivityHistory(files, () => 123);
  await history.observe(session.activity());
  await session.finish('ORDER1');
  await history.observe(session.activity());
  await session.create();
  await history.observe(session.activity());
  const result = await history.summary(session.activity()?.id ?? null);
  assert.equal(result.sessions.length, 2);
  assert.equal(
    result.sessions.find((item) => item.phase === PAYPAL_SESSION_PHASE.VOIDED)
      ?.capturedCents,
    null,
  );
  const restored = new ActivityHistory(files, () => 456);
  assert.deepEqual((await restored.summary(null)).sessions, result.sessions);
  assert.deepEqual(f.calls, ['create', 'authorize', 'void', 'create']);
});

void test('history corruption is visible and is never silently overwritten', async () => {
  let writes = 0;
  const f = fixture();
  const session = await start(f);
  const history = new ActivityHistory({
    read: async () => '{broken',
    write: async () => {
      writes++;
    },
  });
  await history.observe(session.activity());
  const result = await history.summary(null);
  assert.equal(result.available, false);
  assert.equal(writes, 0);
  assert.equal(result.sessions.length, 1);
});

void test('history write failures cannot retry or reject a completed payment', async () => {
  const f = fixture();
  const session = await start(f);
  const history = new ActivityHistory({
    read: async () => undefined,
    write: async () => {
      throw new Error('disk');
    },
  });
  await history.observe(session.activity());
  assert.equal((await history.summary(null)).available, false);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('activity parser rejects forged totals, secrets and duplicate sessions', async () => {
  const session = await start(fixture());
  const history = new ActivityHistory(
    { read: async () => undefined, write: async () => {} },
    () => 123,
  );
  await history.observe(session.activity());
  const valid = await history.summary(session.activity()!.id);
  assert.equal(parseActivityResult(valid).available, true);
  for (const row of [
    { ...valid.sessions[0], capturedCents: 20 },
    { ...valid.sessions[0], agentCents: 100 },
    { ...valid.sessions[0], authorizationId: 'SECRET' },
  ])
    assert.equal(
      parseActivityResult({ ...valid, sessions: [row] }).available,
      false,
    );
  assert.equal(
    parseActivityResult({
      ...valid,
      sessions: [valid.sessions[0], valid.sessions[0]],
    }).available,
    false,
  );
});

void test('chat history counts replies by method without claiming shared session charges', () => {
  const chat = new ChatController('chat', () => 123);
  const model = {
    id: 'synthetic',
    name: 'Synthetic',
    image: { src: '/synthetic.svg' },
    free: false,
  };
  chat.startPaypal('Question', model, 'run', 'a'.repeat(64));
  chat.completePaypal('chat', 'run', 'Answer', model);
  const summary = conversationSummary(chat.getSnapshot().sessions[0]!);
  assert.equal(summary.paypalReplies, 1);
  assert.equal(summary.previewReplies, 0);
  assert.equal(summary.lastSentAt, 123);
  assert.deepEqual(summary.paymentSessionIds, ['a'.repeat(64)]);
  assert.equal('capturedCents' in summary, false);
});

void test('completed agent inference is recorded separately even when delivery is not acknowledged', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      return {
        id: 'synthetic-1',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await session.agentMessage(
    order.orderId,
    {
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'Question' }],
      max_tokens: 16,
      stream: false,
    },
    'AGENT1',
  );
  const entry = session.activity()!;
  assert.equal(entry.agentCount, 1);
  assert.equal(entry.agentCents, 10);
  assert.equal(entry.chatCount, 0);
  assert.equal(entry.chatCents, 0);
  assert.equal(entry.recordedCents, 10);
  assert.equal(entry.capturedCents, null);
});

void test('activity IPC denies other frames and extra arguments before reading history', async () => {
  let reads = 0;
  const contents = {};
  const frame = {};
  let destroyed = false;
  const handlers = createActivityHandlers(
    async () => {
      reads++;
      return { available: true, currentSessionId: null, sessions: [] };
    },
    { contents, mainFrame: () => frame, destroyed: () => destroyed },
  );
  const owner = { sender: contents, senderFrame: frame };
  for (const event of [
    { ...owner, sender: {} },
    { ...owner, senderFrame: {} },
  ])
    assert.equal((await handlers.summary(event, [])).available, false);
  assert.equal((await handlers.summary(owner, [{}])).available, false);
  assert.equal(reads, 0);
  assert.equal((await handlers.summary(owner, [])).available, true);
  destroyed = true;
  assert.equal((await handlers.summary(owner, [])).available, false);
  assert.equal(reads, 1);
});

void test('failed order creation is reviewable, not awaiting a nonexistent approval', async () => {
  const f = fixture();
  f.payment.create = async () => {
    throw new Error('network');
  };
  const session = await createPaypalSession(f);
  await assert.rejects(session.create());
  assert.equal(session.activity()?.needsReview, true);
});

void test('out-of-range dates cannot enter a renderable history result', async () => {
  const session = await start(fixture());
  const history = new ActivityHistory(
    { read: async () => undefined, write: async () => {} },
    () => 123,
  );
  await history.observe(session.activity());
  const valid = await history.summary(null);
  assert.equal(
    parseActivityResult({
      ...valid,
      sessions: [{ ...valid.sessions[0], updatedAt: Number.MAX_SAFE_INTEGER }],
    }).available,
    false,
  );
});

void test('stalled history cannot delay paid answers, subsequent commands or financial cleanup', async () => {
  const session = await start(fixture());
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const history = new ActivityHistory({
    read: async () => undefined,
    write: async () => waiting,
  });
  let disposed = false;
  const observer = new ActivityObserver(
    history,
    () => session.activity(),
    () => history.summary(null),
    async () => {
      disposed = true;
    },
    5,
  );
  observer.capture();
  assert.equal(await observer.run(async () => 'paid answer'), 'paid answer');
  assert.equal(await observer.run(async () => 'next command'), 'next command');
  let closed = false;
  await observer.close(async () => {
    closed = true;
  });
  assert.equal(closed, true);
  assert.equal(disposed, false);
  assert.equal((await observer.summary()).available, false);
  release?.();
  await history.summary(null);
});

void test('private history uses its own writer lock and can be read without starting payments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-activity-'));
  const session = await start(fixture());
  const first = createDesktopActivityStorage(directory, () =>
    session.activity(),
  );
  const second = createDesktopActivityStorage(directory, () =>
    session.activity(),
  );
  try {
    first.capture();
    const initial = await first.summary();
    assert.equal(initial.available, true);
    second.capture();
    assert.equal(await second.run(async () => 'response'), 'response');
    assert.equal((await second.summary()).available, false);
    await first.close(async () => {});
    await second.close(async () => {});
    const reader = createDesktopActivityStorage(directory, () => null);
    assert.deepEqual((await reader.summary()).sessions, initial.sessions);
    await reader.close(async () => {});
    if (process.platform !== 'win32')
      assert.equal(
        (await stat(desktopActivityPaths(directory).state)).mode & 0o777,
        0o600,
      );
  } finally {
    await first.close(async () => {});
    await second.close(async () => {});
    await rm(directory, { recursive: true, force: true });
  }
});
