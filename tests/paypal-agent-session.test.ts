import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

function completion(number: number) {
  return {
    id: `synthetic-${number}`,
    object: 'chat.completion',
    created: 0,
    model: 'synthetic-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `synthetic answer ${number}` },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

void test('one sandbox authorization covers a tool-calling conversation without recording its contents', async () => {
  const f = fixture();
  const seen: unknown[] = [];
  const agentEngine = {
    async generate(input: unknown) {
      seen.push(input);
      f.calls.push('agent-generate');
      return completion(seen.length);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const first = {
    model: 'synthetic-model',
    messages: [
      { role: 'system', content: 'synthetic instruction' },
      { role: 'user', content: 'synthetic request' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    max_tokens: 128,
  };
  const second = {
    ...first,
    messages: [
      ...first.messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'synthetic contents' },
    ],
  };
  const result1 = await session.agentMessage(order.orderId, first, 'MESSAGE1');
  assert.deepEqual(result1.response, completion(1));
  assert.doesNotMatch(JSON.stringify(f.getState()), /synthetic/);
  await session.acknowledge(order.orderId, result1.messageId);
  const result2 = await session.agentMessage(order.orderId, second, 'MESSAGE2');
  assert.deepEqual(result2.response, completion(2));
  await session.acknowledge(order.orderId, result2.messageId);
  await session.finish(order.orderId);
  assert.deepEqual(seen, [first, second]);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'agent-generate',
    'capture:20',
  ]);
});

void test('an unacknowledged agent answer blocks another inference and settlement', async () => {
  const f = fixture();
  const agentEngine = {
    async generate() {
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const request = {
    model: 'synthetic-model',
    messages: [{ role: 'user', content: 'synthetic request' }],
    max_tokens: 128,
  };
  const first = await session.agentMessage(order.orderId, request, 'MESSAGE1');
  await assert.rejects(
    session.agentMessage(order.orderId, request, 'MESSAGE2'),
  );
  await assert.rejects(session.finish(order.orderId));
  await session.acknowledge(order.orderId, first.messageId);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});

void test('malformed agent messages are refused before dispatch or journal changes', async () => {
  const f = fixture();
  const agentEngine = {
    async generate() {
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const before = f.getState();
  for (const messages of [
    [null],
    [{ role: 'user', content: 42 }],
    [{ role: 'tool', content: 'synthetic result' }],
    [{ role: 'system', content: 'synthetic instruction', extra: true }],
  ]) {
    await assert.rejects(
      session.agentMessage(
        order.orderId,
        { model: 'synthetic-model', messages, max_tokens: 128 },
        'MESSAGE1',
      ),
    );
  }
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      {
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic request' }],
        max_tokens: 128,
        n: 2,
      },
      'MESSAGE1',
    ),
  );
  assert.deepEqual(f.getState(), before);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('malformed engine output never becomes an acknowledged charge', async () => {
  const f = fixture();
  const agentEngine = {
    async generate() {
      f.calls.push('agent-generate');
      return { error: 'synthetic upstream error' };
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      {
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic request' }],
        max_tokens: 128,
      },
      'MESSAGE1',
    ),
  );
  assert.equal(session.status().spentCents, 0);
  await assert.rejects(session.finish(order.orderId));
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate']);
});
