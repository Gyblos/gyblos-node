// The local endpoint's chat formats: OpenAI conversations, Anthropic messages and the model list, over
// injected executors and loopback ports only; no seller, network or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAnthropicChat } from '@gyblos/buyer/anthropic-chat';
import { parseFreeChat } from '@gyblos/buyer/free-chat';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const RESULT = {
  text: 'firstsecond',
  usage: { inputTokens: 7, outputTokens: 3 },
  finishReason: ENGINE_DONE_REASONS.LENGTH,
};
const TOKEN = 'synthetic-local-token';

void test('an OpenAI conversation keeps its order, joins turns of one role and leads with the system text', () => {
  const input = parseFreeChat(
    {
      model: 'synthetic',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'developer', content: [{ type: 'text', text: 'use English' }] },
        { role: 'user', content: 'my name is Ana' },
        { role: 'assistant', content: 'hello Ana' },
        { role: 'user', content: 'what is my name?' },
        { role: 'user', content: [{ type: 'text', text: 'one word' }] },
      ],
      temperature: 0.2,
      top_p: 1,
      user: 'synthetic',
      stream_options: { include_usage: true },
      tools: [],
      tool_choice: 'none',
      n: 1,
      max_completion_tokens: 500,
    },
    SELECTION,
    100,
  );
  assert.deepEqual(input.messages, [
    { role: 'system', content: 'be brief\n\nuse English' },
    { role: 'user', content: 'my name is Ana' },
    { role: 'assistant', content: 'hello Ana' },
    { role: 'user', content: 'what is my name?\n\none word' },
  ]);
  // A length above the buyer's maximum is served up to the maximum.
  assert.equal(input.maxTokens, 100);
});

void test('a long history fits up to the message bound, and the bound is enforced', () => {
  const turns = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${index}`,
    }));
  const longest = FREE_EXECUTION.maxMessages - 1;
  assert.equal(
    parseFreeChat(
      { model: 'synthetic', messages: turns(longest) },
      SELECTION,
      10,
    ).messages.length,
    longest,
  );
  assert.throws(
    () =>
      parseFreeChat(
        { model: 'synthetic', messages: turns(FREE_EXECUTION.maxMessages + 1) },
        SELECTION,
        10,
      ),
    /FREE_BUYER_INVALID_REQUEST/,
  );
});

void test('an Anthropic request carries system text apart and needs max_tokens', () => {
  const input = parseAnthropicChat(
    {
      model: 'synthetic',
      max_tokens: 5,
      system: [
        {
          type: 'text',
          text: 'be brief',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: 'bye' },
      ],
      temperature: 0,
      metadata: { user_id: 'synthetic' },
      thinking: { type: 'disabled' },
    },
    SELECTION,
    10,
  );
  assert.deepEqual(input, {
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ],
    maxTokens: 5,
  });
  for (const change of [
    { max_tokens: undefined },
    { tools: [{ name: 'x' }] },
    { stop_sequences: ['x'] },
    { thinking: { type: 'enabled', budget_tokens: 1024 } },
    { messages: [{ role: 'system', content: 'x' }] },
    {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
      ],
    },
  ])
    assert.throws(() =>
      parseAnthropicChat(
        {
          model: 'synthetic',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
          ...change,
        },
        SELECTION,
        10,
      ),
    );
});

async function host(
  options: { token?: string; seen?: FreeExecutionBuildInput[] } = {},
) {
  return startFreeBuyerHttp(
    async (input) => {
      options.seen?.push(input);
      return RESULT;
    },
    { selection: SELECTION, maxTokens: 10 },
    {
      port: 0,
      token: options.token,
      stream: async (input, _signal, onDelta) => {
        options.seen?.push(input);
        await onDelta('first');
        await onDelta('second');
        return RESULT;
      },
    },
  );
}
const base = (url: string) => url.replace(/\/v1\/chat\/completions$/, '');

void test('GET /v1/models lists the one model this buyer asks for', async () => {
  const server = await host();
  try {
    const response = await fetch(`${base(server.url)}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((model: { id: string }) => model.id),
      ['synthetic'],
    );
  } finally {
    await server.close();
  }
});

void test('POST /v1/messages answers in the Anthropic shape, whole or streamed', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host({ seen });
  const request = {
    model: 'synthetic',
    max_tokens: 4,
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
  };
  try {
    const url = `${base(server.url)}/v1/messages?beta=true`;
    const whole = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(whole.status, 200);
    const message = await whole.json();
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.deepEqual(message.content, [{ type: 'text', text: 'firstsecond' }]);
    assert.equal(message.stop_reason, 'max_tokens');
    assert.deepEqual(message.usage, { input_tokens: 7, output_tokens: 3 });
    assert.deepEqual(seen[0], {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      maxTokens: 4,
    });

    const streamed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });
    assert.equal(streamed.status, 200);
    const text = await streamed.text();
    const events = [...text.matchAll(/^event: (\S+)$/gmu)].map(
      (match) => match[1],
    );
    assert.deepEqual(events, [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const deltas = [...text.matchAll(/"text_delta","text":"([^"]*)"/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(deltas, ['first', 'second']);
    assert.match(text, /"stop_reason":"max_tokens"/);

    const refused = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, max_tokens: undefined }),
    });
    assert.equal(refused.status, 400);
    const error = await refused.json();
    assert.equal(error.type, 'error');
    assert.equal(error.error.type, 'invalid_request_error');
    assert.match(error.error.message, /max_tokens is required/);
  } finally {
    await server.close();
  }
});

void test('a token-protected endpoint takes the key as a bearer token or as x-api-key', async () => {
  const server = await host({ token: TOKEN });
  const body = JSON.stringify({
    model: 'synthetic',
    max_tokens: 4,
    messages: [{ role: 'user', content: 'hi' }],
  });
  try {
    const url = `${base(server.url)}/v1/messages`;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    assert.equal((await post({ 'x-api-key': TOKEN })).status, 200);
    assert.equal(
      (await post({ authorization: `Bearer ${TOKEN}` })).status,
      200,
    );
    assert.equal((await post({ 'x-api-key': 'wrong' })).status, 401);
    assert.equal((await post({})).status, 401);
  } finally {
    await server.close();
  }
});
