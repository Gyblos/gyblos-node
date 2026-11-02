import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

const model = 'synthetic-model';
function request(text: string) {
  return { model, messages: [{ role: 'user', content: text }], max_tokens: 64 };
}
function completion(text = 'synthetic answer') {
  return {
    id: 'synthetic',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

void test('a final write that persisted before failing is reconciled on restart without a second charge', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return completion();
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (
      value &&
      typeof value === 'object' &&
      'agentCompletions' in value &&
      Array.isArray(value.agentCompletions) &&
      value.agentCompletions.length
    )
      throw new Error('failed after write');
  };
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      request('synthetic'),
      'AGENT1',
      undefined,
      'operation-1',
    ),
  );
  assert.equal(session.status().phase, 'blocked');
  await assert.rejects(session.finish(order.orderId));
  f.journal.write = write;
  const restarted = await createPaypalSession({ ...f, agentEngine });
  assert.equal(restarted.status().spentCents, 10);
  await assert.rejects(
    restarted.agentMessage(
      order.orderId,
      request('synthetic'),
      'AGENT2',
      undefined,
      'operation-1',
    ),
  );
  await restarted.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});

void test('a version 2 pending chat remains pending after restart until acknowledged', async () => {
  const f = fixture();
  f.setState({
    version: 2,
    phase: 'message_pending',
    requestId: 'REQUEST1',
    currency: 'USD',
    limitCents: 100,
    messageCents: 10,
    maxMessageAttempts: 30,
    spentCents: 10,
    attemptIds: ['CHAT1'],
    acknowledgedIds: [],
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    expiresAt: Date.now() + 60000,
    messageId: 'CHAT1',
    promptDigest: 'a'.repeat(64),
  });
  const session = await createPaypalSession(f);
  await assert.rejects(session.finish('ORDER1'));
  await session.acknowledge('ORDER1', 'CHAT1');
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, ['capture:10']);
});

void test('a malformed version 3 record cannot resume or settle', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      return completion();
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await session.agentMessage(
    order.orderId,
    request('synthetic'),
    'AGENT1',
    undefined,
    'operation-1',
  );
  const original = f.getState();
  assert.ok(original && typeof original === 'object');
  const rows: unknown = Reflect.get(original, 'agentCompletions');
  assert.ok(Array.isArray(rows));
  const first: unknown = rows[0];
  assert.ok(first && typeof first === 'object');
  for (const mutation of [
    { spentCents: 0 },
    { agentCompletions: [first, first], spentCents: 20 },
    { agentCompletions: [{ ...first, messageId: 'UNKNOWN' }] },
    { acknowledgedIds: ['AGENT1'], spentCents: 20 },
    { agentCompletions: [{ ...first, requestDigest: 'invalid' }] },
    { unexpected: true },
  ]) {
    f.setState({ ...original, ...mutation });
    await assert.rejects(createPaypalSession({ ...f, agentEngine }));
  }
});

void test('a disconnect before dispatch does not run or charge the agent model', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return completion();
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (
      value &&
      typeof value === 'object' &&
      Reflect.get(value, 'phase') === 'executing'
    )
      controller.abort();
  };
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      request('synthetic'),
      'AGENT1',
      controller.signal,
    ),
  );
  assert.equal(session.status().spentCents, 0);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('the private journal accommodates the maximum bounded version 3 record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-agent-journal-test-'));
  try {
    const journal = await openPaypalJournal(root);
    const attemptIds = Array.from({ length: 30 }, (_, index) =>
      `ID${index}`.padEnd(64, 'x'),
    );
    const agentCompletions = attemptIds
      .slice(0, 10)
      .map((messageId, index) => ({
        messageId,
        requestDigest: 'a'.repeat(64),
        idempotencyDigest: index.toString(16).padStart(64, '0'),
      }));
    await journal.write({
      version: 3,
      phase: 'active',
      requestId: 'R'.repeat(64),
      currency: 'USD',
      limitCents: 100,
      messageCents: 10,
      maxMessageAttempts: 30,
      spentCents: 100,
      attemptIds,
      acknowledgedIds: [],
      agentCompletions,
      orderId: 'O'.repeat(64),
      authorizationId: 'A'.repeat(64),
      expiresAt: Date.now() + 60000,
    });
    const f = fixture();
    const session = await createPaypalSession({ ...f, journal });
    assert.equal(session.status().spentCents, 100);
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a version 2 authorization keeps chat semantics and cannot acquire the new agent policy', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return completion();
    },
  };
  f.setState({
    version: 2,
    phase: 'active',
    requestId: 'REQUEST1',
    currency: 'USD',
    limitCents: 100,
    messageCents: 10,
    maxMessageAttempts: 30,
    spentCents: 0,
    attemptIds: [],
    acknowledgedIds: [],
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    expiresAt: Date.now() + 60000,
  });
  const session = await createPaypalSession({ ...f, agentEngine });
  await assert.rejects(
    session.agentMessage('ORDER1', request('synthetic'), 'AGENT1'),
  );
  const chat = await session.message('ORDER1', 'synthetic chat', 16, 'CHAT1');
  assert.equal(session.status().phase, 'message_pending');
  await session.acknowledge('ORDER1', chat.messageId);
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, ['generate', 'capture:10']);
});

void test('an invalid agent result and an uncertain final journal write both block the session', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      return completion('');
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await assert.rejects(
    session.agentMessage(order.orderId, request('synthetic'), 'AGENT1'),
  );
  await assert.rejects(session.finish(order.orderId));
  const restarted = await createPaypalSession({ ...f, agentEngine });
  await assert.rejects(
    restarted.agentMessage(order.orderId, request('another'), 'AGENT2'),
  );

  const g = fixture();
  const goodEngine = {
    model,
    async generate() {
      return completion();
    },
  };
  const current = await createPaypalSession({ ...g, agentEngine: goodEngine });
  const nextOrder = await current.create();
  await current.approve(nextOrder.orderId);
  const write = g.journal.write;
  g.journal.write = async (value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      'agentCompletions' in value &&
      Array.isArray(value.agentCompletions) &&
      value.agentCompletions.length
    )
      throw new Error('disk failed');
    await write(value);
  };
  await assert.rejects(
    current.agentMessage(nextOrder.orderId, request('synthetic'), 'AGENT1'),
  );
  assert.equal(current.status().phase, 'blocked');
  await assert.rejects(current.finish(nextOrder.orderId));
  const recovered = await createPaypalSession({
    ...g,
    agentEngine: goodEngine,
  });
  await assert.rejects(recovered.finish(nextOrder.orderId));
});

void test('agent usage cannot exceed the approved limit', async () => {
  const f = fixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return completion();
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  for (let i = 0; i < 10; i += 1) {
    await session.agentMessage(
      order.orderId,
      request(`synthetic ${i}`),
      `AGENT${i}`,
    );
  }
  await assert.rejects(
    session.agentMessage(order.orderId, request('eleventh'), 'AGENT11'),
  );
  assert.equal(session.status().spentCents, 100);
  assert.equal(f.calls.filter((call) => call === 'agent-generate').length, 10);
  await session.finish(order.orderId);
  assert.equal(f.calls.at(-1), 'capture:100');
});
