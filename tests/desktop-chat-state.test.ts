// Synthetic, unfunded offline conversation regressions; no engine or network access.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceRun,
  CHAT_PHASE,
  createSession,
  MESSAGE_STATE,
  startRun,
  stopRun,
  toggleToolSelection,
} from '@gyblos/desktop/chat-state';

const model = {
  id: 'sample-model',
  name: 'Sample model',
  image: { src: '/synthetic-model.svg' },
  free: true,
};
function started() {
  return startRun(
    createSession('a'),
    'A synthetic question',
    model,
    [],
    'run-a',
  );
}
function writing() {
  return advanceRun(started(), 'run-a');
}

void test('a new conversation starts empty, without inheriting a running reply', () => {
  const old = started();
  const fresh = createSession('b');
  assert.equal(advanceRun(fresh, old.run!.id), fresh);
  assert.equal(fresh.messages.length, 0);
});
void test('a stale run cannot change the current conversation', () => {
  const current = started();
  assert.equal(advanceRun(current, 'other-run'), current);
});
void test('stopping a run rejects its late timer events', () => {
  const stopped = stopRun(writing());
  assert.equal(advanceRun(stopped, 'run-a'), stopped);
  assert.equal(stopped.messages.at(-1)!.state, MESSAGE_STATE.STOPPED);
});
void test('a stopped old run cannot overwrite a replacement run in the same session', () => {
  const replacement = startRun(
    stopRun(writing()),
    'Another question',
    model,
    [],
    'run-b',
  );
  assert.equal(advanceRun(replacement, 'run-a'), replacement);
  assert.equal(replacement.run!.id, 'run-b');
});
void test('a new run starts with the connecting phase', () => {
  assert.equal(started().run!.phase, CHAT_PHASE.CONNECTING);
});
void test('a run without tools goes directly from connecting to responding', () => {
  assert.equal(writing().run!.phase, CHAT_PHASE.RESPONDING);
});
void test('a run with tools exposes the tools phase before responding', () => {
  const run = startRun(createSession('a'), 'Read context', model, ['exa'], 'r');
  const tools = advanceRun(run, 'r');
  assert.equal(tools.run!.phase, CHAT_PHASE.TOOLS);
  assert.equal(advanceRun(tools, 'r').run!.phase, CHAT_PHASE.RESPONDING);
});
void test('partial output grows progressively, not as a complete answer', () => {
  const partial = advanceRun(writing(), 'run-a');
  assert.ok(partial.messages.at(-1)!.text.length > 0);
  assert.ok(partial.messages.at(-1)!.text.length < partial.run!.reply.length);
  assert.equal(partial.messages.at(-1)!.state, MESSAGE_STATE.PENDING);
});
void test('stopping retains text that already arrived', () => {
  const partial = advanceRun(writing(), 'run-a');
  const stopped = stopRun(partial);
  assert.equal(stopped.messages.at(-1)!.text, partial.messages.at(-1)!.text);
  assert.equal(stopped.run, null);
});
void test('completion is explicit and cannot be appended twice', () => {
  let session = writing();
  for (let i = 0; session.run && i < 100; i++)
    session = advanceRun(session, 'run-a');
  assert.equal(session.run, null);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages.at(-1)!.state, MESSAGE_STATE.COMPLETE);
  assert.equal(advanceRun(session, 'run-a'), session);
});
void test('changing the selected model cannot relabel a pending answer', () => {
  const changingModel = { ...model };
  const session = startRun(
    createSession('a'),
    'Question',
    changingModel,
    [],
    'r',
  );
  changingModel.name = 'New selection';
  assert.equal(session.run!.model.name, 'Sample model');
  assert.equal(session.messages.at(-1)!.model.name, 'Sample model');
});
void test('typing a follow-up during streaming keeps that draft', () => {
  const session = { ...writing(), draft: 'A follow-up draft' };
  assert.equal(advanceRun(session, 'run-a').draft, 'A follow-up draft');
});
void test('a second send cannot overlap an existing run', () => {
  const session = started();
  assert.equal(
    startRun(session, 'Another question', model, [], 'run-b'),
    session,
  );
});
void test('empty requests cannot create turns', () => {
  const session = createSession('a');
  assert.equal(startRun(session, '   ', model, [], 'r'), session);
});
void test('tool selections are snapshotted independently of later changes', () => {
  const tools: ('exa' | 'firecrawl')[] = ['exa'];
  const session = startRun(createSession('a'), 'Question', model, tools, 'r');
  tools.push('firecrawl');
  assert.deepEqual(session.run!.tools, ['exa']);
  assert.deepEqual(session.messages.at(-1)!.tools, ['exa']);
});

void test('reconnecting a stale selected tool enables it rather than toggling it off', () => {
  assert.deepEqual(toggleToolSelection(['exa'], [], 'exa'), ['exa']);
});
