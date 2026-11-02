import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture as paymentFixture } from './support/paypal-session-fixture';

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

function fixture(finishReason: 'stop' | 'length' = 'stop') {
  const requests: unknown[] = [];
  const gateway = createPaypalAgentGateway({
    origin,
    model,
    key,
    service: {
      async sendAgent(input: unknown) {
        requests.push(input);
        const first = requests.length === 1 && finishReason === 'stop';
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
                finish_reason: first ? 'tool_calls' : finishReason,
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

function streamEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const value: unknown = JSON.parse(line.slice(6));
      assert.ok(value && typeof value === 'object');
      return Object.fromEntries(Object.entries(value));
    });
}

function post(
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
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

void test('Responses maps a streamed function call and its result to one session', async () => {
  const f = fixture();
  const input = {
    model,
    max_output_tokens: 128,
    instructions: 'synthetic instruction',
    input: [
      {
        type: 'message',
        id: null,
        role: 'developer',
        content: [
          { type: 'input_text', text: 'synthetic developer instruction' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'synthetic request' }],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'read_file',
        parameters: tool.function.parameters,
        strict: false,
      },
    ],
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'synthetic-session',
    client_metadata: { session_id: 'synthetic-session' },
  };
  const response = await f.gateway.handle(post('/v1/responses', input));
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
  );
  const streamed = await response.text();
  assert.match(streamed, /event: response.output_item.done/);
  assert.match(streamed, /"type":"function_call"/);
  assert.match(streamed, /"call_id":"call_1"/);
  assert.match(streamed, /event: response.completed/);
  const events = streamEvents(streamed);
  const item = events.find((event) => event.type === 'response.output_item.added')?.item;
  assert.ok(item && typeof item === 'object' && 'arguments' in item);
  const delta = events.find((event) => event.type === 'response.function_call_arguments.delta')?.delta;
  assert.equal(typeof item.arguments, 'string');
  assert.equal(typeof delta, 'string');
  assert.deepEqual(JSON.parse(`${item.arguments}${delta}`), {});
  const next = await f.gateway.handle(
    post('/v1/responses', {
      ...input,
      stream: false,
      input: [
        ...input.input,
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'synthetic contents',
        },
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

void test('Responses streams message content once, starting with an empty item', async () => {
  const f = fixture('length');
  const input = { model, input: 'synthetic request', max_output_tokens: 128 };
  const streamed = await f.gateway.handle(post('/v1/responses', { ...input, stream: true }));
  const events = streamEvents(await streamed.text());
  const item = events.find((event) => event.type === 'response.output_item.added')?.item;
  assert.ok(item && typeof item === 'object' && 'content' in item);
  assert.deepEqual(item.content, []);
  const delta = events.find((event) => event.type === 'response.output_text.delta')?.delta;
  assert.equal(delta, 'synthetic answer');
  const incomplete = events.find((event) => event.type === 'response.incomplete')?.response;
  assert.ok(incomplete && typeof incomplete === 'object' && 'output' in incomplete && 'incomplete_details' in incomplete);
  assert.deepEqual(incomplete.incomplete_details, { reason: 'max_output_tokens' });
  assert.ok(Array.isArray(incomplete.output));
  assert.equal(incomplete.output[0]?.status, 'incomplete');
  const json = await f.gateway.handle(post('/v1/responses', input));
  const result: unknown = await json.json();
  assert.ok(result && typeof result === 'object' && 'output' in result && 'incomplete_details' in result);
  assert.deepEqual(result.incomplete_details, { reason: 'max_output_tokens' });
  assert.ok(Array.isArray(result.output));
  assert.equal(result.output[0]?.status, 'incomplete');
});

void test('Claude accepts a tool result without optional content', async () => {
  const f = fixture('length');
  const response = await f.gateway.handle(post('/v1/messages', {
    model,
    max_tokens: 128,
    messages: [
      { role: 'user', content: 'synthetic request' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1' }] },
    ],
  }));
  assert.equal(response.status, 200);
  const request = f.requests[0];
  assert.ok(request && typeof request === 'object' && 'messages' in request);
  assert.ok(Array.isArray(request.messages));
  assert.deepEqual(request.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '' });
});

void test('Claude forwards bounded mid-conversation system text only at valid turn boundaries', async () => {
  const f = fixture('length');
  const first = { role: 'user', content: 'synthetic request' };
  const reminder = { role: 'system', content: [{ type: 'text', text: 'synthetic reminder' }] };
  const valid = await f.gateway.handle(post('/v1/messages', {
    model,
    max_tokens: 128,
    system: 'synthetic instruction',
    messages: [first, reminder],
  }));
  assert.equal(valid.status, 200);
  const request = f.requests[0];
  assert.ok(request && typeof request === 'object' && 'messages' in request);
  assert.deepEqual(request.messages, [
    { role: 'system', content: 'synthetic instruction' },
    first,
    { role: 'system', content: 'synthetic reminder' },
  ]);
  const invalidPosition = await f.gateway.handle(post('/v1/messages', {
    model,
    max_tokens: 128,
    messages: [first, reminder, first],
  }));
  assert.equal(invalidPosition.status, 400);
  const pendingTool = await f.gateway.handle(post('/v1/messages', {
    model,
    max_tokens: 128,
    messages: [
      first,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }] },
      { role: 'user', content: 'not a tool result' },
      reminder,
    ],
  }));
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
  const result1 = { type: 'tool_result', tool_use_id: 'call_1', content: 'first' };
  const result2 = { type: 'tool_result', tool_use_id: 'call_2', content: 'second' };
  const text = { type: 'text', text: 'synthetic follow-up' };
  const request = (content: unknown[]) => post('/v1/messages', {
    model,
    max_tokens: 128,
    messages: [first, calls, { role: 'user', content }],
  });
  assert.equal((await f.gateway.handle(request([text, result1, result2]))).status, 400);
  assert.equal((await f.gateway.handle(request([result1, text, result2]))).status, 400);
  assert.equal((await f.gateway.handle(request([result1]))).status, 400);
  assert.equal((await f.gateway.handle(request([result1, result1]))).status, 400);
  assert.equal((await f.gateway.handle(request([result1, result2, text]))).status, 200);
  assert.equal(f.requests.length, 1);
});

void test('Responses does not invent unknown cached or reasoning token counts', async () => {
  const f = fixture('length');
  const response = await f.gateway.handle(post('/v1/responses', {
    model,
    input: 'synthetic request',
    max_output_tokens: 128,
  }));
  const result: unknown = await response.json();
  assert.ok(result && typeof result === 'object' && 'usage' in result);
  assert.equal(result.usage, null);
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
    post(
      '/v1/responses',
      { model, input: 'synthetic' },
      { authorization: 'Bearer wrong' },
    ),
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(f.requests, []);
});

void test('Codex requests without an explicit output limit use the agent limit', async () => {
  const f = fixture();
  const response = await f.gateway.handle(
    post('/v1/responses', {
      model,
      input: 'synthetic request',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          parameters: tool.function.parameters,
          strict: false,
        },
      ],
      stream: true,
      store: false,
    }),
  );
  assert.equal(response.status, 200);
  const request = f.requests[0];
  assert.ok(request && typeof request === 'object' && 'max_tokens' in request);
  assert.equal(request.max_tokens, 512);
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
