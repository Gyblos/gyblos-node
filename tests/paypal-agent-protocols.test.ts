import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';

const origin = 'http://127.0.0.1:12345';
const model = 'synthetic-model';
const key = 'synthetic-test-key';
const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    parameters: { type: 'object', properties: {} },
  },
};

function fixture() {
  const requests: unknown[] = [];
  const gateway = createPaypalAgentGateway({
    origin,
    model,
    key,
    service: {
      async sendAgent(input: unknown) {
        requests.push(input);
        const first = requests.length === 1;
        return {
          messageId: `MESSAGE${requests.length}`,
          response: {
            id: `synthetic-${requests.length}`,
            object: 'chat.completion',
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: first
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'read_file', arguments: '{}' },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'synthetic answer' },
                finish_reason: first ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          },
        };
      },
    },
  });
  return { gateway, requests };
}

function post(path: string, input: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(input),
  });
}

void test('Claude Messages maps a streamed tool call and its result to one session', async () => {
  const f = fixture();
  const input = {
    model,
    max_tokens: 128,
    system: 'synthetic instruction',
    messages: [{ role: 'user', content: 'synthetic request' }],
    tools: [{ name: 'read_file', input_schema: tool.function.parameters }],
    stream: true,
  };
  const response = await f.gateway.handle(post('/v1/messages?beta=true', input));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
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
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'synthetic contents' }] },
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

void test('Responses maps a streamed function call and its result to one session', async () => {
  const f = fixture();
  const input = {
    model,
    max_output_tokens: 128,
    instructions: 'synthetic instruction',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'synthetic request' }] }],
    tools: [{ type: 'function', name: 'read_file', parameters: tool.function.parameters, strict: false }],
    stream: true,
    store: false,
  };
  const response = await f.gateway.handle(post('/v1/responses', input));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const streamed = await response.text();
  assert.match(streamed, /event: response.output_item.done/);
  assert.match(streamed, /"type":"function_call"/);
  assert.match(streamed, /"call_id":"call_1"/);
  assert.match(streamed, /event: response.completed/);
  const next = await f.gateway.handle(
    post('/v1/responses', {
      ...input,
      stream: false,
      input: [
        ...input.input,
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'synthetic contents' },
      ],
    }),
  );
  assert.equal(next.status, 200);
  const output: unknown = await next.json();
  assert.ok(output && typeof output === 'object' && 'status' in output);
  assert.equal(output.status, 'completed');
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

void test('unsupported or unauthenticated client requests never dispatch inference', async () => {
  const f = fixture();
  const response = await f.gateway.handle(
    post('/v1/messages', {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
    }),
  );
  assert.equal(response.status, 400);
  const unauthorized = await f.gateway.handle(
    post('/v1/responses', { model, input: 'synthetic' }, { authorization: 'Bearer wrong' }),
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(f.requests, []);
});
