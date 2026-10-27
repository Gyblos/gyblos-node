// Exercises the renderer's session coordinator with a deterministic synthetic clock.
// No DOM, wallet, network, inference, persistence or payment side effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ChatController,
  type ChatScheduler,
} from '@gyblos/desktop/chat-controller';
import { CHAT_PHASE, MESSAGE_STATE } from '@gyblos/desktop/chat-state';
import { DEMO_AUTH } from '@gyblos/desktop/demo-account';

const model = {
  id: 'synthetic',
  name: 'Synthetic model',
  free: true,
  image: { src: '/synthetic.svg' },
};
class Clock implements ChatScheduler {
  private time = 0;
  private nextId = 0;
  private readonly tasks = new Map<
    number,
    { at: number; callback: () => void }
  >();
  readonly callbacks: (() => void)[] = [];
  schedule = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delay, callback });
    this.callbacks.push(callback);
    return () => {
      this.tasks.delete(id);
    };
  };
  advance(duration: number) {
    const end = this.time + duration;
    while (true) {
      const next = [...this.tasks]
        .filter(([, task]) => task.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = end;
  }
  get pending() {
    return this.tasks.size;
  }
}
function setup() {
  const chat = new ChatController('a');
  const clock = new Clock();
  const detach = chat.attachScheduler(clock);
  return { chat, clock, detach };
}
function session(chat: ChatController, id: string) {
  return chat.getSnapshot().sessions.find((item) => item.id === id)!;
}
function start(chat: ChatController, id: string) {
  return chat.start(
    'A synthetic question',
    model,
    [],
    id,
    () => DEMO_AUTH.APPROVED,
  );
}

void test('new chat preserves a running answer and the old follow-up draft', () => {
  const { chat } = setup();
  start(chat, 'run-a');
  chat.setDraft('Follow-up in a');
  chat.newChat('b');
  assert.equal(session(chat, 'a').run?.id, 'run-a');
  assert.equal(session(chat, 'a').draft, 'Follow-up in a');
  assert.equal(session(chat, 'b').messages.length, 0);
  assert.equal(session(chat, 'b').draft, '');
});
void test('history selection leaves both sessions running and preserves distinct drafts', () => {
  const { chat } = setup();
  start(chat, 'run-a');
  chat.setDraft('Draft a');
  chat.newChat('b');
  start(chat, 'run-b');
  chat.setDraft('Draft b');
  chat.openChat('a');
  assert.equal(session(chat, 'a').run?.id, 'run-a');
  assert.equal(session(chat, 'b').run?.id, 'run-b');
  assert.equal(session(chat, 'a').draft, 'Draft a');
  assert.equal(session(chat, 'b').draft, 'Draft b');
});
void test('background responses complete while a third chat remains empty', () => {
  const { chat, clock } = setup();
  start(chat, 'run-a');
  chat.newChat('b');
  start(chat, 'run-b');
  chat.newChat('c');
  chat.setDraft('Unsent c');
  clock.advance(10000);
  for (const id of ['a', 'b']) {
    assert.equal(session(chat, id).run, null);
    assert.equal(
      session(chat, id).messages.at(-1)?.state,
      MESSAGE_STATE.COMPLETE,
    );
    assert.ok(session(chat, id).messages.at(-1)!.text.length > 0);
  }
  assert.equal(chat.getSnapshot().activeId, 'c');
  assert.equal(session(chat, 'c').draft, 'Unsent c');
  assert.deepEqual(session(chat, 'c').messages, []);
  assert.equal(clock.pending, 0);
});
void test('rapid navigation and typing do not restart response deadlines', () => {
  const { chat, clock } = setup();
  start(chat, 'run-a');
  clock.advance(250);
  chat.newChat('b');
  for (let index = 0; index < 5; index++) {
    chat.openChat('a');
    chat.setDraft('Draft a ' + index);
    chat.openChat('b');
    chat.setDraft('Draft b ' + index);
  }
  clock.advance(650);
  assert.equal(session(chat, 'a').run?.phase, CHAT_PHASE.RESPONDING);
  assert.equal(session(chat, 'a').draft, 'Draft a 4');
  assert.equal(session(chat, 'b').draft, 'Draft b 4');
});
void test('stop affects only the active answer and retains its partial output', () => {
  const { chat, clock } = setup();
  start(chat, 'run-a');
  chat.newChat('b');
  start(chat, 'run-b');
  clock.advance(1030);
  const partial = session(chat, 'b').messages.at(-1)!.text;
  assert.ok(partial.length > 0);
  chat.stop();
  assert.equal(
    session(chat, 'b').messages.at(-1)?.state,
    MESSAGE_STATE.STOPPED,
  );
  assert.equal(session(chat, 'b').messages.at(-1)?.text, partial);
  clock.advance(10000);
  assert.equal(
    session(chat, 'a').messages.at(-1)?.state,
    MESSAGE_STATE.COMPLETE,
  );
  assert.equal(session(chat, 'b').messages.at(-1)?.text, partial);
});
void test('detaching cancels timers and stale callbacks cannot change a remounted controller', () => {
  const { chat, clock, detach } = setup();
  start(chat, 'run-a');
  const stale = clock.callbacks[0]!;
  detach();
  assert.equal(clock.pending, 0);
  const snapshot = chat.getSnapshot();
  stale();
  assert.equal(chat.getSnapshot(), snapshot);
  const detachAgain = chat.attachScheduler(clock);
  clock.advance(900);
  assert.equal(session(chat, 'a').run?.phase, CHAT_PHASE.RESPONDING);
  detachAgain();
  assert.equal(clock.pending, 0);
});
void test('a late stopped callback cannot overwrite a replacement response', () => {
  const { chat, clock } = setup();
  start(chat, 'run-a');
  const stale = clock.callbacks[0]!;
  chat.stop();
  start(chat, 'run-b');
  const snapshot = chat.getSnapshot();
  stale();
  assert.equal(chat.getSnapshot(), snapshot);
  assert.equal(session(chat, 'a').run?.id, 'run-b');
});
void test('offline stops existing runs without dropping drafts or silently resuming them', () => {
  const { chat, clock } = setup();
  start(chat, 'run-a');
  chat.setDraft('Unsent');
  chat.setOnline(false);
  clock.advance(10000);
  chat.setOnline(true);
  assert.equal(session(chat, 'a').run, null);
  assert.equal(session(chat, 'a').draft, 'Unsent');
  assert.equal(clock.pending, 0);
});
for (const [status, expected] of [
  [DEMO_AUTH.BALANCE, /balance.*free model/i],
  [DEMO_AUTH.LIMIT, /daily.*limit.*free model/i],
  [DEMO_AUTH.OFFLINE, /connection.*paused.*draft/i],
] as const) {
  void test(`a blocked ${status} send stays in its chat, retains the draft and explains the reason`, () => {
    const { chat, clock } = setup();
    chat.setDraft('Unsent draft');
    assert.equal(
      chat.start('Unsent draft', model, [], 'blocked', () => status),
      false,
    );
    const before = session(chat, 'a');
    assert.equal(chat.getSnapshot().activeId, 'a');
    assert.equal(before.draft, 'Unsent draft');
    assert.deepEqual(before.messages, []);
    assert.match(before.notice, expected);
    assert.equal(clock.pending, 0);
    chat.newChat('b');
    assert.equal(session(chat, 'b').notice, '');
    chat.openChat('a');
    assert.equal(session(chat, 'a').notice, before.notice);
    assert.equal(start(chat, 'allowed'), true);
    assert.equal(session(chat, 'a').notice, '');
    assert.equal(session(chat, 'a').draft, '');
  });
}
void test('an offline controller explains the block without invoking authorization', () => {
  const { chat } = setup();
  chat.setOnline(false);
  chat.setDraft('Offline draft');
  assert.equal(
    chat.start('Offline draft', model, [], 'blocked', () => {
      throw new Error('Must not authorize');
    }),
    false,
  );
  assert.match(session(chat, 'a').notice, /connection.*paused.*draft/i);
});
void test('rapid duplicate sends do not invoke authorization twice', () => {
  const { chat } = setup();
  let calls = 0;
  const authorize = () => {
    calls++;
    return DEMO_AUTH.APPROVED;
  };
  assert.equal(chat.start('Question', model, [], 'one', authorize), true);
  assert.equal(chat.start('Question', model, [], 'two', authorize), false);
  assert.equal(calls, 1);
  assert.equal(session(chat, 'a').messages.length, 2);
});

void test('a deferred copy failure stays with its originating conversation', async () => {
  const { chat } = setup();
  const origin = chat.getSnapshot().activeId;
  const copy = Promise.reject(new Error('Synthetic clipboard rejection')).catch(
    () => {
      chat.setNotice('Copy unavailable', origin);
    },
  );
  chat.newChat('b');
  await copy;
  assert.equal(session(chat, 'a').notice, 'Copy unavailable');
  assert.equal(session(chat, 'b').notice, '');
});

void test('choosing a free model clears paid blockers but preserves unrelated notices and drafts', () => {
  const { chat } = setup();
  chat.setDraft('Draft a');
  chat.start('Draft a', model, [], 'blocked-a', () => DEMO_AUTH.BALANCE);
  chat.newChat('b', 'Draft b');
  chat.setNotice('Copy unavailable');
  chat.modelChanged(true);
  assert.equal(session(chat, 'a').notice, '');
  assert.equal(session(chat, 'a').draft, 'Draft a');
  assert.equal(session(chat, 'b').notice, 'Copy unavailable');
  assert.equal(session(chat, 'b').draft, 'Draft b');
});
