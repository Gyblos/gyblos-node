import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';

const model = 'synthetic-model';
const origin = 'http://127.0.0.1:12345';
const key = 'synthetic-test-key';
const firstAnswer = {
  id: 'synthetic-1',
  object: 'chat.completion',
  created: 0,
  model,
  choices: [
    {
      index: 0,
      message: {
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
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};
const secondAnswer = {
  ...firstAnswer,
  id: 'synthetic-2',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'synthetic answer' },
      finish_reason: 'stop',
    },
  ],
};
const input = {
  model,
  messages: [{ role: 'user', content: 'synthetic request' }],
  tools: [
    {
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object' } },
    },
  ],
  max_tokens: 128,
};

function fixture() {
  const calls: string[] = [];
  let phase = 'active';
  let count = 0;
  const service = {
    status: () => ({ phase }),
    async sendAgent() {
      calls.push('generate');
      phase = 'message_pending';
      count += 1;
      return { response: count === 1 ? firstAnswer : secondAnswer, messageId: `MSG${count}` };
    },
    async acknowledge(messageId: string) {
      calls.push(`ack:${messageId}`);
      phase = 'active';
    },
  };
  return { calls, gateway: createPaypalAgentGateway({ origin, key, model, service }) };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

void test('the local gateway requires its key and rejects browser origins', async () => {
  const f = fixture();
  assert.equal((await f.gateway.handle(post(input, { authorization: 'Bearer wrong' }))).status, 401);
  assert.equal((await f.gateway.handle(post(input, { origin: 'https://attacker.invalid' }))).status, 403);
  assert.equal((await f.gateway.handle(post(input, { host: 'attacker.invalid' }))).status, 403);
  assert.deepEqual(f.calls, []);
});

void test('a following agent request acknowledges the prior response only when its history includes it', async () => {
  const f = fixture();
  const first = await f.gateway.handle(post(input));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), firstAnswer);
  assert.equal((await f.gateway.handle(post(input))).status, 409);
  assert.deepEqual(f.calls, ['generate']);
  const second = {
    ...input,
    messages: [
      ...input.messages,
      firstAnswer.choices[0].message,
      { role: 'tool', tool_call_id: 'call_1', content: 'synthetic contents' },
    ],
  };
  const next = await f.gateway.handle(post(second));
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), secondAnswer);
  assert.deepEqual(f.calls, ['generate', 'ack:MSG1', 'generate']);
  await f.gateway.acknowledgePending();
  assert.deepEqual(f.calls, ['generate', 'ack:MSG1', 'generate', 'ack:MSG2']);
});

void test('streaming clients receive an SSE representation only after the complete response', async () => {
  const f = fixture();
  const response = await f.gateway.handle(post({ ...input, stream: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /tool_calls/);
  assert.match(text, /call_1/);
  assert.match(text, /data: \[DONE\]/);
  assert.deepEqual(f.calls, ['generate']);
});
