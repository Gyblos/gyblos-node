// The OpenAI-compatible and Anthropic engines with tools: the request carries tools, the tool choice and tool
// turns in each provider's shape, and the streamed calls come back whole with finish reason tool_calls. A
// synthetic fetch stands in for the provider; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicEngine } from '@gyblos/engine-anthropic/engine';
import { createOpenAiEngine } from '@gyblos/engine-openai/engine';
import {
  TOOL_CALLS_DONE,
  type ToolChatMessage,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_time',
    description: 'Current time',
    parameters: '{"type":"object","properties":{"zone":{"type":"string"}}}',
  },
];
const LOOP: ToolChatMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Time in UTC and Lima?' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'a', name: 'get_time', arguments: '{"zone":"UTC"}' },
      { id: 'b', name: 'get_time', arguments: '{"zone":"America/Lima"}' },
    ],
  },
  { role: 'tool', content: '12:00', toolCallId: 'a' },
  { role: 'tool', content: '07:00', toolCallId: 'b' },
];

function provider(events: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const stream = events
      .map(
        (event) =>
          `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
      )
      .join('');
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { fetchImpl, bodies };
}

void test('OpenAI-compatible: tools and tool turns go out in its shape, and streamed calls come back whole', async () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const { fetchImpl, bodies } = provider([
    chunk({ role: 'assistant', content: 'One moment.' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_x',
          type: 'function',
          function: { name: 'get_time', arguments: '{"zo' },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: 'ne":"UTC"}' } }],
    }),
    chunk({}, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } },
    '[DONE]',
  ]);
  const engine = createOpenAiEngine(
    {
      base: 'https://llm.example/v1',
      model: 'm',
      contextTokens: 8192,
      recountable: false,
    },
    fetchImpl,
  );
  assert.equal(engine.supportsTools?.(), true);
  const result = await engine.generate({
    messages: LOOP,
    tools: TOOLS,
    toolChoice: 'required',
    maxTokens: 100,
  });
  assert.equal(result.text, 'One moment.');
  assert.equal(result.finishReason, TOOL_CALLS_DONE);
  assert.deepEqual(result.toolCalls, [
    { id: 'call_x', name: 'get_time', arguments: '{"zone":"UTC"}' },
  ]);
  const body = bodies[0]!;
  assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Current time',
        parameters: {
          type: 'object',
          properties: { zone: { type: 'string' } },
        },
      },
    },
  ]);
  const messages = body.messages as Record<string, unknown>[];
  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'a',
        type: 'function',
        function: { name: 'get_time', arguments: '{"zone":"UTC"}' },
      },
      {
        id: 'b',
        type: 'function',
        function: { name: 'get_time', arguments: '{"zone":"America/Lima"}' },
      },
    ],
  });
  assert.deepEqual(messages[4], {
    role: 'tool',
    tool_call_id: 'b',
    content: '07:00',
  });
});

void test('Anthropic: results are tool_result blocks in one user turn, and tool_use blocks come back as calls', async () => {
  const { fetchImpl, bodies } = provider([
    { type: 'message_start', message: { usage: { input_tokens: 50 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Checking.' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_time',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"zone":' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"UTC"}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 20 },
    },
    { type: 'message_stop' },
  ]);
  const engine = createAnthropicEngine(
    {
      base: 'https://api.example',
      model: 'm',
      contextTokens: 8192,
      apiKey: 'synthetic',
    },
    fetchImpl,
  );
  const result = await engine.generate({
    messages: LOOP,
    tools: TOOLS,
    toolChoice: { name: 'get_time' },
    maxTokens: 100,
  });
  assert.equal(result.text, 'Checking.');
  assert.equal(result.finishReason, TOOL_CALLS_DONE);
  assert.deepEqual(result.toolCalls, [
    { id: 'toolu_1', name: 'get_time', arguments: '{"zone":"UTC"}' },
  ]);
  const body = bodies[0]!;
  assert.equal(body.system, 'Be brief.');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'get_time' });
  const turns = body.messages as { role: string; content: unknown }[];
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[1]!.content, [
    { type: 'tool_use', id: 'a', name: 'get_time', input: { zone: 'UTC' } },
    {
      type: 'tool_use',
      id: 'b',
      name: 'get_time',
      input: { zone: 'America/Lima' },
    },
  ]);
  assert.deepEqual(turns[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'a', content: '12:00' },
      { type: 'tool_result', tool_use_id: 'b', content: '07:00' },
    ],
  });
});

void test('a call to a tool the request did not offer is a malformed response', async () => {
  const { fetchImpl } = provider([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'c', function: { name: 'rm', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ]);
  const engine = createOpenAiEngine(
    {
      base: 'https://llm.example/v1',
      model: 'm',
      contextTokens: 8192,
      recountable: false,
    },
    fetchImpl,
  );
  await assert.rejects(
    engine.generate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      maxTokens: 10,
    }),
  );
});
