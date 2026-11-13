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

void test('agent inference preserves a configurable session limit', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      return completion(1);
    },
  };
  const payment = {
    ...f.payment,
    async beginReview(
      _order: string,
      _request: string,
      authorizationId: string,
    ) {
      return {
        capture: (cents: number) => f.payment.capture(authorizationId, cents),
        release() {},
      };
    },
  };
  const session = await createPaypalSession({ ...f, payment, agentEngine });
  const order = await session.create(undefined, 500);
  await session.approve(order.orderId);
  await session.agentMessage(
    order.orderId,
    {
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'synthetic request' }],
      max_tokens: 128,
    },
    'MESSAGE1',
  );
  assert.equal(session.status().spentCents, 10);
  assert.equal(session.status().limitCents, 500);
  await session.finish(order.orderId);
  assert.equal(f.calls.at(-1), 'capture:10');
});

void test('one sandbox authorization covers a tool-calling conversation without recording its contents', async () => {
  const f = fixture();
  const seen: unknown[] = [];
  const agentEngine = {
    model: 'synthetic-model',
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
  const result2 = await session.agentMessage(order.orderId, second, 'MESSAGE2');
  assert.deepEqual(result2.response, completion(2));
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

void test('a repeated agent request is refused while the completed charge can be settled', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
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
  await session.agentMessage(order.orderId, request, 'MESSAGE1');
  await assert.rejects(
    session.agentMessage(order.orderId, request, 'MESSAGE2'),
  );
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});

void test('malformed engine output never becomes an acknowledged charge', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
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

void test('an empty response cannot become an acknowledged charge', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      const response = completion(1);
      const choice = response.choices[0];
      assert.ok(choice);
      choice.message.content = '';
      return response;
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
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 128,
      },
      'MESSAGE1',
    ),
  );
  assert.equal(session.status().spentCents, 0);
});

void test('a reentrant validator cannot start two paid inferences', async () => {
  const f = fixture();
  let entered = false;
  let reentry: Promise<unknown> | undefined;
  let session: Awaited<ReturnType<typeof createPaypalSession>>;
  const validateRequest = () => {
    if (entered) return;
    entered = true;
    reentry = session.message('ORDER1', 'synthetic reentrant', 16, 'REENTER');
    void reentry.catch(() => {});
  };
  session = await createPaypalSession({ ...f, validateRequest });
  const order = await session.create();
  await session.approve(order.orderId);
  const first = await session.message(
    order.orderId,
    'synthetic outer',
    16,
    'OUTER',
  );
  assert.ok(reentry);
  await assert.rejects(reentry);
  await session.acknowledge(order.orderId, first.messageId);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('a stream-like engine result cannot be settled as a completed response', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      return new ReadableStream();
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
        stream: true,
        max_tokens: 128,
      },
      'MESSAGE1',
    ),
  );
  assert.equal(session.status().spentCents, 0);
  await assert.rejects(session.finish(order.orderId));
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate']);
});

void test('the agent cannot select another model or conflicting output limits', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const body = {
    model: 'synthetic-model',
    messages: [{ role: 'user', content: 'synthetic request' }],
    max_tokens: 128,
  };
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      { ...body, model: 'other' },
      'MESSAGE1',
    ),
  );
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      { ...body, max_completion_tokens: 2048 },
      'MESSAGE1',
    ),
  );
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('engine-specific limits are checked before journaling an agent attempt', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    validate(input: unknown) {
      assert.ok(input && typeof input === 'object' && 'max_tokens' in input);
      if (input.max_tokens !== 128) throw new Error('unsupported output limit');
    },
    async generate() {
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const before = f.getState();
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      {
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic request' }],
        max_tokens: 1024,
      },
      'MESSAGE1',
    ),
  );
  assert.deepEqual(f.getState(), before);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('chat and agent turns share the same authorization while chat awaits acknowledgment', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const chat = await session.message(
    order.orderId,
    'synthetic request',
    16,
    'CHAT',
  );
  const agentRequest = {
    model: 'synthetic-model',
    messages: [{ role: 'user', content: 'synthetic request' }],
    max_tokens: 128,
  };
  await assert.rejects(
    session.agentMessage(order.orderId, agentRequest, 'AGENT'),
  );
  await session.acknowledge(order.orderId, chat.messageId);
  await session.agentMessage(order.orderId, agentRequest, 'AGENT');
  assert.equal(session.status().phase, 'active');
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'agent-generate',
    'capture:20',
  ]);
});
