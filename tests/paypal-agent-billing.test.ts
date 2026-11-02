import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

const model = 'synthetic-model';
function request(text: string) {
  return { model, messages: [{ role: 'user', content: text }], max_tokens: 64 };
}
function completion(text = 'synthetic answer') {
  return {
    id: 'synthetic', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

void test('completed agent inferences are recorded before delivery and share the chat limit', async () => {
  const f = fixture();
  const agentEngine = { model, async generate() { f.calls.push('agent-generate'); return completion(); } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await session.agentMessage(order.orderId, request('first synthetic'), 'AGENT1');
  assert.equal(session.status().phase, 'active');
  assert.equal(session.status().spentCents, 10);
  const chat = await session.message(order.orderId, 'synthetic chat', 16, 'CHAT1');
  await assert.rejects(session.agentMessage(order.orderId, request('second synthetic'), 'AGENT2'));
  await session.acknowledge(order.orderId, chat.messageId);
  await session.agentMessage(order.orderId, request('second synthetic'), 'AGENT2');
  assert.equal(session.status().spentCents, 30);
  assert.doesNotMatch(JSON.stringify(f.getState()), /first synthetic|second synthetic|synthetic answer/);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate', 'generate', 'agent-generate', 'capture:30']);
});

void test('disconnect after dispatch cannot cancel or erase a completed charge', async () => {
  const f = fixture();
  let entered = () => {};
  let release = () => {};
  let seenSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const agentEngine = { model, async generate(_input: unknown, signal?: AbortSignal) {
    seenSignal = signal;
    f.calls.push('agent-generate'); entered(); await waiting; return completion();
  } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const controller = new AbortController();
  const pending = session.agentMessage(order.orderId, request('synthetic'), 'AGENT1', controller.signal);
  await started;
  controller.abort();
  release();
  await pending;
  assert.equal(seenSignal, undefined);
  assert.equal(session.status().spentCents, 10);
  assert.equal(session.status().phase, 'active');
  const restarted = await createPaypalSession({ ...f, agentEngine });
  assert.equal(restarted.status().spentCents, 10);
  await restarted.finish(order.orderId);
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate', 'capture:10']);
});

void test('a repeated unkeyed agent request is rejected without generating or charging twice', async () => {
  const f = fixture();
  const agentEngine = { model, async generate() { f.calls.push('agent-generate'); return completion(); } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const first = request('synthetic');
  await session.agentMessage(order.orderId, first, 'AGENT1');
  const same = { max_tokens: 64, messages: first.messages, model, stream: true };
  await assert.rejects(session.agentMessage(order.orderId, same, 'AGENT2'));
  assert.equal(session.status().spentCents, 10);
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate']);
});

void test('an idempotency key permits explicit repetitions but cannot be reused', async () => {
  const f = fixture();
  const agentEngine = { model, async generate() { f.calls.push('agent-generate'); return completion(); } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await session.agentMessage(order.orderId, request('synthetic'), 'AGENT1', undefined, 'operation-1');
  await assert.rejects(session.agentMessage(order.orderId, request('different synthetic'), 'AGENT2', undefined, 'operation-1'));
  await session.agentMessage(order.orderId, request('synthetic'), 'AGENT3', undefined, 'operation-2');
  assert.equal(session.status().spentCents, 20);
  assert.doesNotMatch(JSON.stringify(f.getState()), /operation-1|operation-2/);
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate', 'agent-generate']);
});

void test('a completed result is not returned before its charge is recorded', async () => {
  const f = fixture();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const write = f.journal.write;
  const agentEngine = { model, async generate() { return completion(); } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  f.journal.write = async (value: unknown) => {
    if (value && typeof value === 'object' && 'agentCompletions' in value && Array.isArray(value.agentCompletions) && value.agentCompletions.length) { entered(); await waiting; }
    await write(value);
  };
  let returned = false;
  const pending = session.agentMessage(order.orderId, request('synthetic'), 'AGENT1').then(() => { returned = true; });
  await Promise.race([started, pending]);
  assert.equal(returned, false);
  release();
  await pending;
  assert.equal(session.status().spentCents, 10);
});
