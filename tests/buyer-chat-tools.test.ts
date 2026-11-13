// Tool calling on the local endpoint in both client formats: requests read into protocol tools and turns
// (including what Claude Code sends), answers and streams that carry the model's calls, and the estimated
// count_tokens. Injected executors and loopback ports only; no seller or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAnthropicChat } from '@gyblos/buyer/anthropic-chat';
import { parseFreeChat } from '@gyblos/buyer/free-chat';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import { TOOL_CALLS_DONE } from '@gyblos/protocol/tools';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const SCHEMA = { type: 'object', properties: { zone: { type: 'string' } } };
const CALL = { id: 'call_1', name: 'get_time', arguments: '{"zone":"UTC"}' };
const RESULT: FreeExecutionResult = {
  text: '',
  toolCalls: [CALL],
  usage: { inputTokens: 30, outputTokens: 9 },
  finishReason: TOOL_CALLS_DONE,
};

void test('an OpenAI tool loop becomes tools, an assistant call and its result', () => {
  const input = parseFreeChat(
    {
      model: 'synthetic',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: 'Time',
            parameters: SCHEMA,
            strict: true,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_time' } },
      parallel_tool_calls: false,
      messages: [
        { role: 'user', content: 'Time in UTC?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_time', arguments: '{"zone":"UTC"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
      ],
    },
    SELECTION,
    100,
  );
  assert.deepEqual(input.tools, [
    {
      name: 'get_time',
      description: 'Time',
      parameters: JSON.stringify(SCHEMA),
    },
  ]);
  assert.deepEqual(input.toolChoice, { name: 'get_time' });
  assert.deepEqual(input.messages, [
    { role: 'user', content: 'Time in UTC?' },
    { role: 'assistant', content: '', toolCalls: [CALL] },
    { role: 'tool', content: '12:00', toolCallId: 'call_1' },
  ]);
  // A choice that names no offered tool, and the legacy functions API, are refused.
  for (const change of [
    { tool_choice: { type: 'function', function: { name: 'other' } } },
    { functions: [{ name: 'get_time' }] },
  ])
    assert.throws(() =>
      parseFreeChat(
        {
          ...input,
          model: 'synthetic',
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          ...change,
        },
        SELECTION,
        100,
      ),
    );
});

void test('what Claude Code sends is read: cached blocks, thinking and effort settings, results with text', () => {
  const input = parseAnthropicChat(
    {
      model: 'synthetic',
      max_tokens: 64,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      context_management: { edits: [] },
      metadata: { user_id: 'synthetic' },
      system: [
        {
          type: 'text',
          text: 'You are an agent.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: 'get_time',
          description: 'Time',
          input_schema: SCHEMA,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'system', content: 'Extra instructions.' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Time in UTC?',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden', signature: 'x' },
            { type: 'text', text: 'Checking.' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'get_time',
              input: { zone: 'UTC' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: '12:00' }],
            },
            { type: 'text', text: 'And Lima?' },
          ],
        },
      ],
    },
    SELECTION,
    100,
    true,
  );
  assert.equal(input.toolChoice, 'auto');
  assert.deepEqual(input.messages, [
    { role: 'system', content: 'You are an agent.\n\nExtra instructions.' },
    { role: 'user', content: 'Time in UTC?' },
    { role: 'assistant', content: 'Checking.', toolCalls: [CALL] },
    { role: 'tool', content: '12:00', toolCallId: 'call_1' },
    { role: 'user', content: 'And Lima?' },
  ]);
});

async function host(seen: FreeExecutionBuildInput[], tools = true) {
  return startFreeBuyerHttp(
    async (input) => {
      seen.push(input);
      return RESULT;
    },
    { selection: SELECTION, maxTokens: 50, tools },
    {
      port: 0,
      stream: async (input) => {
        seen.push(input);
        return RESULT;
      },
    },
  );
}
const base = (url: string) => url.replace(/\/v1\/chat\/completions$/, '');
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const OPENAI_REQUEST = {
  model: 'synthetic',
  tools: [
    { type: 'function', function: { name: 'get_time', parameters: SCHEMA } },
  ],
  messages: [{ role: 'user', content: 'Time?' }],
};
const ANTHROPIC_REQUEST = {
  model: 'synthetic',
  max_tokens: 20,
  tools: [{ name: 'get_time', input_schema: SCHEMA }],
  messages: [{ role: 'user', content: 'Time?' }],
};

void test('OpenAI answers carry the calls, whole and streamed, and the executor gets the tools', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(seen);
  try {
    const whole = await (await post(server.url, OPENAI_REQUEST)).json();
    assert.equal(whole.choices[0].finish_reason, 'tool_calls');
    assert.equal(whole.choices[0].message.content, null);
    assert.deepEqual(whole.choices[0].message.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_time', arguments: '{"zone":"UTC"}' },
      },
    ]);
    assert.equal(seen[0]?.tools?.[0]?.name, 'get_time');

    const streamed = await (
      await post(server.url, { ...OPENAI_REQUEST, stream: true })
    ).text();
    assert.match(
      streamed,
      /"tool_calls":\[\{"index":0,"id":"call_1","type":"function"/,
    );
    assert.match(streamed, /"finish_reason":"tool_calls"/);
    assert.match(streamed, /data: \[DONE\]/);
  } finally {
    await server.close();
  }
});

void test('Anthropic answers carry tool_use blocks, whole and streamed, and count_tokens estimates', async () => {
  const server = await host([]);
  const url = `${base(server.url)}/v1/messages`;
  try {
    const whole = await (await post(url, ANTHROPIC_REQUEST)).json();
    assert.equal(whole.stop_reason, 'tool_use');
    assert.deepEqual(whole.content, [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'get_time',
        input: { zone: 'UTC' },
      },
    ]);

    const streamed = await (
      await post(url, { ...ANTHROPIC_REQUEST, stream: true })
    ).text();
    const events = [...streamed.matchAll(/^event: (\S+)$/gmu)].map(
      (match) => match[1],
    );
    assert.deepEqual(events, [
      'message_start',
      'content_block_start',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.match(
      streamed,
      /"index":1,"content_block":\{"type":"tool_use","id":"call_1","name":"get_time","input":\{\}\}/,
    );
    assert.match(streamed, /"partial_json":"\{\\"zone\\":\\"UTC\\"\}"/);
    assert.match(streamed, /"stop_reason":"tool_use"/);

    const count = await post(`${url}/count_tokens`, ANTHROPIC_REQUEST);
    assert.equal(count.status, 200);
    const { input_tokens } = await count.json();
    assert.ok(Number.isSafeInteger(input_tokens) && input_tokens > 0);
  } finally {
    await server.close();
  }
});

void test('an endpoint that may route to paid execution refuses tools instead of dropping them', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(seen, false);
  try {
    const refused = await post(server.url, OPENAI_REQUEST);
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.error.param, 'tools');
    assert.match(body.error.message, /free offers only/);
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});
