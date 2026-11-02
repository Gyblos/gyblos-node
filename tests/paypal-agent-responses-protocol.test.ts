import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fixture,
  model,
  post,
  streamEvents,
  tool,
} from './support/paypal-agent-protocol-fixture';

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
  const item = events.find(
    (event) => event.type === 'response.output_item.added',
  )?.item;
  assert.ok(item && typeof item === 'object' && 'arguments' in item);
  const delta = events.find(
    (event) => event.type === 'response.function_call_arguments.delta',
  )?.delta;
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
  const streamed = await f.gateway.handle(
    post('/v1/responses', { ...input, stream: true }),
  );
  const events = streamEvents(await streamed.text());
  const item = events.find(
    (event) => event.type === 'response.output_item.added',
  )?.item;
  assert.ok(item && typeof item === 'object' && 'content' in item);
  assert.deepEqual(item.content, []);
  const delta = events.find(
    (event) => event.type === 'response.output_text.delta',
  )?.delta;
  assert.equal(delta, 'synthetic answer');
  const incomplete = events.find(
    (event) => event.type === 'response.incomplete',
  )?.response;
  assert.ok(
    incomplete &&
      typeof incomplete === 'object' &&
      'output' in incomplete &&
      'incomplete_details' in incomplete,
  );
  assert.deepEqual(incomplete.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assert.ok(Array.isArray(incomplete.output));
  assert.equal(incomplete.output[0]?.status, 'incomplete');
  const json = await f.gateway.handle(post('/v1/responses', input));
  const result: unknown = await json.json();
  assert.ok(
    result &&
      typeof result === 'object' &&
      'output' in result &&
      'incomplete_details' in result,
  );
  assert.deepEqual(result.incomplete_details, { reason: 'max_output_tokens' });
  assert.ok(Array.isArray(result.output));
  assert.equal(result.output[0]?.status, 'incomplete');
});

void test('Responses does not invent unknown cached or reasoning token counts', async () => {
  const f = fixture('length');
  const response = await f.gateway.handle(
    post('/v1/responses', {
      model,
      input: 'synthetic request',
      max_output_tokens: 128,
    }),
  );
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
