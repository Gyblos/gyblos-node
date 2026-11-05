import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOllamaAgent } from '@gyblos/engine-ollama/agent';
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';

import { fixture } from './support/paypal-session-fixture';

void test('the agent gateway performs several paid inferences without acknowledgment and rejects retries', async () => {
  const f = fixture();
  const model = 'synthetic-model';
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return {
        id: 'synthetic',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  let counter = 0;
  const service = {
    status: () => session.status(),
    acknowledge: async (id: string) => session.acknowledge(order.orderId, id),
    sendAgent: async (
      input: unknown,
      signal?: AbortSignal,
      idempotencyKey?: string,
    ) =>
      session.agentMessage(
        order.orderId,
        input,
        `AGENT${++counter}`,
        signal,
        idempotencyKey,
      ),
  };
  const origin = 'http://127.0.0.1:12345';
  const gateway = createPaypalAgentGateway({
    origin,
    key: 'test-key',
    model,
    service,
  });
  function post(text: string, idempotencyKey?: string) {
    return new Request(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:12345',
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        max_tokens: 16,
      }),
    });
  }
  assert.equal((await gateway.handle(post('first', 'one'))).status, 200);
  const duplicate = await gateway.handle(post('first', 'one'));
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.code, 'PAYPAL_DUPLICATE_REQUEST');
  assert.equal((await gateway.handle(post('second', 'two'))).status, 200);
  assert.equal((await gateway.handle(post('second'))).status, 400);
  assert.equal(
    (await gateway.handle(post('third', 'invalid key'))).status,
    400,
  );
  assert.equal(session.status().spentCents, 20);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'agent-generate',
  ]);
  await session.finish(order.orderId);
  assert.equal(f.calls.at(-1), 'capture:20');
});

void test('an uncertain inference requires review instead of triggering repeated client retries', async () => {
  const f = fixture();
  const model = 'synthetic-model';
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      throw new Error('synthetic timeout');
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  let counter = 0;
  const service = {
    sendAgent: async (input: unknown, signal?: AbortSignal, key?: string) =>
      session.agentMessage(
        order.orderId,
        input,
        `AGENT${++counter}`,
        signal,
        key,
      ),
  };
  const origin = 'http://127.0.0.1:12345';
  const gateway = createPaypalAgentGateway({
    origin,
    key: 'test-key',
    model,
    service,
  });
  function request() {
    return new Request(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:12345',
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 16,
      }),
    });
  }
  assert.equal((await gateway.handle(request())).status, 400);
  assert.equal((await gateway.handle(request())).status, 400);
  await assert.rejects(session.finish(order.orderId));
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate']);
});

void test('agent tool constraints preserve earlier usage and block settlement on an invalid result', async () => {
  for (const valid of [true, false]) {
    const f = fixture();
    const model = 'synthetic-model';
    const agentEngine = createOllamaAgent(
      'http://127.0.0.1:11434/',
      async () => {
        f.calls.push('agent-generate');
        return Response.json({
          model,
          created_at: '2026-01-01T00:00:00Z',
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'read_file',
                  arguments: { path: valid ? 'ses_file' : 'bad' },
                },
              },
            ],
          },
          prompt_eval_count: 2,
          eval_count: 3,
        });
      },
      { model },
    );
    const session = await createPaypalSession({ ...f, agentEngine });
    const order = await session.create();
    await session.approve(order.orderId);
    for (const id of ['MESSAGE1', 'MESSAGE2']) {
      await session.message(order.orderId, 'synthetic', 16, id);
      await session.acknowledge(order.orderId, id);
    }
    const origin = 'http://127.0.0.1:12345';
    const gateway = createPaypalAgentGateway({
      origin,
      key: 'test-key',
      model,
      service: {
        sendAgent: (input: unknown) =>
          session.agentMessage(order.orderId, input, 'AGENT1'),
      },
    });
    const response = await gateway.handle(
      new Request(`${origin}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:12345',
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 16,
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', minLength: 4, pattern: '^ses' },
                  },
                  required: ['path'],
                },
              },
            },
          ],
        }),
      }),
    );
    if (valid) {
      assert.equal(response.status, 200);
      assert.equal(session.status().spentCents, 30);
      await session.finish(order.orderId);
      assert.equal(f.calls.at(-1), 'capture:30');
    } else {
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error.code,
        PAYPAL_ERROR_CODES.INFERENCE_FAILED,
      );
      assert.equal(session.status().phase, PAYPAL_SESSION_PHASE.EXECUTING);
      assert.equal(session.status().spentCents, 20);
      await assert.rejects(session.finish(order.orderId));
      assert.deepEqual(f.calls, [
        'create',
        'authorize',
        'generate',
        'generate',
        'agent-generate',
      ]);
    }
  }
});
