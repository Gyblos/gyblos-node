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

void test('equivalent Pi text blocks and string messages cannot be charged twice', async () => {
  const f = fixture();
  const received: unknown[] = [];
  const agentEngine = {
    model: 'synthetic-model',
    async generate(input: unknown) {
      received.push(input);
      f.calls.push('agent-generate');
      return completion(1);
    },
  };
  const session = await createPaypalSession({ ...f, agentEngine });
  const order = await session.create();
  await session.approve(order.orderId);
  const common = { model: 'synthetic-model', max_tokens: 128 };
  await session.agentMessage(
    order.orderId,
    {
      ...common,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'synthetic request' }],
        },
      ],
    },
    'MESSAGE1',
  );
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      { ...common, messages: [{ role: 'user', content: 'synthetic request' }] },
      'MESSAGE2',
    ),
  );
  assert.deepEqual(received, [
    { ...common, messages: [{ role: 'user', content: 'synthetic request' }] },
  ]);
  await session.finish(order.orderId);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});
