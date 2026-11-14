import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fixture,
  key,
  model,
  origin,
  post,
  tool,
} from './support/paypal-agent-protocol-fixture';

void test('Claude Messages maps a streamed tool call and its result to one session', async () => {
  const f = fixture();
  const input = {
    model,
    max_tokens: 128,
    system: 'synthetic instruction',
    metadata: { user_id: 'synthetic-client' },
    messages: [{ role: 'user', content: 'synthetic request' }],
    tools: [{ name: 'read_file', input_schema: tool.function.parameters }],
    stream: true,
  };
  const response = await f.gateway.handle(
    post('/v1/messages?beta=true', input),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
  );
  const streamed = await response.text();
  assert.match(streamed, /event: message_start/);
  assert.match(streamed, /event: content_block_start/);
  assert.match(streamed, /"type":"tool_use"/);
  assert.match(streamed, /"id":"call_1"/);
  assert.match(streamed, /event: message_stop/);
  const next = await f.gateway.handle(
    post('/v1/messages', {
      ...input,
      stream: false,
      messages: [
        ...input.messages,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'synthetic contents',
            },
          ],
        },
      ],
    }),
  );
  assert.equal(next.status, 200);
  const output: unknown = await next.json();
  assert.ok(output && typeof output === 'object' && 'stop_reason' in output);
  assert.equal(output.stop_reason, 'end_turn');
  assert.equal(f.requests.length, 2);
  const second = f.requests[1];
  assert.ok(second && typeof second === 'object' && 'messages' in second);
  assert.ok(Array.isArray(second.messages));
  assert.deepEqual(second.messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'synthetic contents',
  });
});

void test('Claude accepts a tool result without optional content', async () => {
  const f = fixture('length');
  const response = await f.gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'synthetic request' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1' }],
        },
      ],
    }),
  );
  assert.equal(response.status, 200);
  const request = f.requests[0];
  assert.ok(request && typeof request === 'object' && 'messages' in request);
  assert.ok(Array.isArray(request.messages));
  assert.deepEqual(request.messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '',
  });
});

void test('Claude forwards bounded mid-conversation system text only at valid turn boundaries', async () => {
  const f = fixture('length');
  const first = { role: 'user', content: 'synthetic request' };
  const reminder = {
    role: 'system',
    content: [{ type: 'text', text: 'synthetic reminder' }],
  };
  const reminderString = { role: 'system', content: 'second reminder' };
  const valid = await f.gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      system: 'synthetic instruction',
      messages: [first, reminder, reminderString],
    }),
  );
  assert.equal(valid.status, 200);
  const request = f.requests[0];
  assert.ok(request && typeof request === 'object' && 'messages' in request);
  assert.deepEqual(request.messages, [
    { role: 'system', content: 'synthetic instruction' },
    first,
    { role: 'system', content: 'synthetic reminder' },
    reminderString,
  ]);
  const invalidPosition = await f.gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [first, reminder, first],
    }),
  );
  assert.equal(invalidPosition.status, 400);
  const pendingTool = await f.gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [
        first,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
          ],
        },
        { role: 'user', content: 'not a tool result' },
        reminder,
      ],
    }),
  );
  assert.equal(pendingTool.status, 400);
  assert.equal(f.requests.length, 1);
});

void test('Claude requires all tool results first in the next user turn', async () => {
  const f = fixture('length');
  const first = { role: 'user', content: 'synthetic request' };
  const calls = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'read_file', input: {} },
    ],
  };
  const result1 = {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'first',
  };
  const result2 = {
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: 'second',
  };
  const text = { type: 'text', text: 'synthetic follow-up' };
  const request = (content: unknown[]) =>
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [first, calls, { role: 'user', content }],
    });
  assert.equal(
    (await f.gateway.handle(request([text, result1, result2]))).status,
    400,
  );
  assert.equal(
    (await f.gateway.handle(request([result1, text, result2]))).status,
    400,
  );
  assert.equal((await f.gateway.handle(request([result1]))).status, 400);
  assert.equal(
    (await f.gateway.handle(request([result1, result1]))).status,
    400,
  );
  assert.equal(
    (await f.gateway.handle(request([result1, result2, text]))).status,
    200,
  );
  assert.equal(f.requests.length, 1);
});

void test('Claude API keys obey the same origin and authentication checks', async () => {
  const f = fixture();
  const input = {
    model,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'synthetic' }],
    tools: [{ name: 'read_file', input_schema: tool.function.parameters }],
  };
  const accepted = new Request(`${origin}/v1/messages`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      'x-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  assert.equal((await f.gateway.handle(accepted)).status, 200);
  assert.equal(
    (
      await f.gateway.handle(
        post('/v1/messages', input, { 'x-api-key': 'wrong' }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.gateway.handle(
        post('/v1/messages', input, { origin: 'https://attacker.invalid' }),
      )
    ).status,
    403,
  );
  assert.equal(f.requests.length, 1);
});
