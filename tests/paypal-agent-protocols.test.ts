import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import {
  key,
  model,
  origin,
  post,
  tool,
} from './support/paypal-agent-protocol-fixture';
import { fixture as paymentFixture } from './support/paypal-session-fixture';

void test('equivalent Claude and OpenAI requests cannot be charged twice', async () => {
  const f = paymentFixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return {
        id: 'synthetic-answer',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'synthetic answer' },
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
  let count = 0;
  const gateway = createPaypalAgentGateway({
    origin,
    key,
    model,
    service: {
      sendAgent(input, signal, idempotencyKey) {
        count += 1;
        return session.agentMessage(
          order.orderId,
          input,
          `MESSAGE${count}`,
          signal,
          idempotencyKey,
        );
      },
    },
  });
  const first = await gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'synthetic request' }],
    }),
  );
  assert.equal(first.status, 200);
  const equivalent = await gateway.handle(
    post('/v1/responses', {
      model,
      max_output_tokens: 128,
      input: [{ role: 'user', content: 'synthetic request' }],
      parallel_tool_calls: true,
    }),
  );
  assert.equal(equivalent.status, 400);
  for (let mask = 0; mask < 8; mask += 1) {
    const retry = await gateway.handle(
      post('/v1/chat/completions', {
        model,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'synthetic request' }],
        ...(mask & 1 ? { parallel_tool_calls: true } : {}),
        ...(mask & 2 ? { n: 1 } : {}),
        ...(mask & 4 ? { tool_choice: 'auto' } : {}),
      }),
    );
    assert.equal(retry.status, 400, `default combination ${mask}`);
  }
  const repeated = await gateway.handle(
    post('/v1/chat/completions', {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'synthetic request' }],
    }),
  );
  assert.equal(repeated.status, 400);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});

void test('tool choice none remains distinct from automatic tool choice', async () => {
  const f = paymentFixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return {
        id: 'synthetic-answer',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'synthetic answer' },
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
  const request = {
    model,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'synthetic request' }],
    tools: [tool],
  };
  await session.agentMessage(
    order.orderId,
    { ...request, tool_choice: 'auto' },
    'MESSAGE1',
  );
  await session.agentMessage(
    order.orderId,
    { ...request, tool_choice: 'none' },
    'MESSAGE2',
  );
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'agent-generate',
    'capture:20',
  ]);
});

void test('a prior Chat Completions request with explicit defaults blocks an equivalent Responses retry', async () => {
  const f = paymentFixture();
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return {
        id: 'synthetic-answer',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'synthetic answer' },
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
  let count = 0;
  const gateway = createPaypalAgentGateway({
    origin,
    key,
    model,
    service: {
      sendAgent(input, signal, idempotencyKey) {
        count += 1;
        return session.agentMessage(
          order.orderId,
          input,
          `MESSAGE${count}`,
          signal,
          idempotencyKey,
        );
      },
    },
  });
  const first = await gateway.handle(
    post('/v1/chat/completions', {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'synthetic request' }],
      parallel_tool_calls: true,
      n: 1,
      tool_choice: 'auto',
    }),
  );
  assert.equal(first.status, 200);
  const retry = await gateway.handle(
    post('/v1/responses', {
      model,
      max_output_tokens: 128,
      input: [{ role: 'user', content: 'synthetic request' }],
    }),
  );
  assert.equal(retry.status, 400);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});
