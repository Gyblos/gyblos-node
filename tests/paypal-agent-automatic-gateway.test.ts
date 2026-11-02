import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('the agent gateway performs several paid inferences without acknowledgment and rejects retries', async () => {
  const f = fixture();
  const model = 'synthetic-model';
  const agentEngine = { model, async generate() {
    f.calls.push('agent-generate');
    return { id: 'synthetic', object: 'chat.completion', created: 0, model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  } };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  let counter = 0;
  const service = {
    status: () => session.status(),
    acknowledge: async (id: string) => session.acknowledge(order.orderId, id),
    sendAgent: async (input: unknown, signal?: AbortSignal, idempotencyKey?: string) =>
      session.agentMessage(order.orderId, input, `AGENT${++counter}`, signal, idempotencyKey),
  };
  const origin = 'http://127.0.0.1:12345';
  const gateway = createPaypalAgentGateway({ origin, key: 'test-key', model, service });
  function post(text: string, idempotencyKey?: string) {
    return new Request(`${origin}/v1/chat/completions`, { method: 'POST',
      headers: { host: '127.0.0.1:12345', authorization: 'Bearer test-key', 'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], max_tokens: 16 }),
    });
  }
  assert.equal((await gateway.handle(post('first', 'one'))).status, 200);
  const duplicate = await gateway.handle(post('first', 'one'));
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.code, 'PAYPAL_DUPLICATE_REQUEST');
  assert.equal((await gateway.handle(post('second', 'two'))).status, 200);
  assert.equal((await gateway.handle(post('second'))).status, 400);
  assert.equal((await gateway.handle(post('third', 'invalid key'))).status, 400);
  assert.equal(session.status().spentCents, 20);
  assert.deepEqual(f.calls, ['create', 'authorize', 'agent-generate', 'agent-generate']);
  await session.finish(order.orderId);
  assert.equal(f.calls.at(-1), 'capture:20');
});
