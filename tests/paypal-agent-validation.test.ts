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

void test('malformed agent messages are refused before dispatch or journal changes', async () => {
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
  const before = f.getState();
  for (const messages of [
    [null],
    [{ role: 'user', content: 42 }],
    [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.invalid/image' },
          },
        ],
      },
    ],
    [
      {
        role: 'user',
        content: [{ type: 'text', text: 'synthetic', extra: true }],
      },
    ],
    [{ role: 'user', content: [] }],
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
  for (const toolChoice of [['none'], ['required'], ['auto']]) {
    await assert.rejects(
      session.agentMessage(
        order.orderId,
        {
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'synthetic request' }],
          max_tokens: 128,
          tool_choice: toolChoice,
        },
        'MESSAGE1',
      ),
    );
  }
  assert.deepEqual(f.getState(), before);
  assert.deepEqual(f.calls, ['create', 'authorize']);
});
