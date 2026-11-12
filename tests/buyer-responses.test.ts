// OpenAI's Responses API on the local buyer endpoint, as Codex CLI sends it: developer instructions, user
// turns, function calls grouped into one assistant turn and answered by their outputs, the stream's event
// order, a whole answer's items, and explicit refusals for state, structured output, reasoning items,
// non-function tools and non-text parts. Injected executors and loopback ports only; no seller or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import {
  CALLS,
  CODEX,
  developer,
  events,
  host,
  MODEL,
  post,
  TEXT,
  user,
} from './support/buyer-responses';

void test('a Codex request becomes one conversation: instructions first, calls grouped, outputs answered', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    const response = await post(server.url, {
      ...CODEX,
      instructions: 'You are Codex.',
      input: [
        developer('Sandbox: read-only.'),
        user('<environment_context>cwd</environment_context>'),
        user('list files'),
        {
          type: 'function_call',
          call_id: 'call_a',
          name: 'shell',
          arguments: '{"command":["ls"]}',
        },
        {
          type: 'function_call',
          call_id: 'call_b',
          name: 'shell',
          arguments: '{"command":["pwd"]}',
        },
        { type: 'function_call_output', call_id: 'call_a', output: 'a.txt' },
        {
          type: 'function_call_output',
          call_id: 'call_b',
          output: [{ type: 'input_text', text: '/work' }],
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Found a.txt.', annotations: [] },
          ],
        },
        // Codex tells the model when the user switched models: a later developer message.
        developer('The user switched models.'),
        user('thanks'),
      ],
    });
    assert.equal(response.status, 200);
    const input = seen[0];
    assert.ok(input);
    assert.deepEqual(input.messages, [
      { role: 'system', content: 'You are Codex.\n\nSandbox: read-only.' },
      {
        role: 'user',
        content: '<environment_context>cwd</environment_context>\n\nlist files',
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_a', name: 'shell', arguments: '{"command":["ls"]}' },
          { id: 'call_b', name: 'shell', arguments: '{"command":["pwd"]}' },
        ],
      },
      { role: 'tool', content: 'a.txt', toolCallId: 'call_a' },
      { role: 'tool', content: '/work', toolCallId: 'call_b' },
      { role: 'assistant', content: 'Found a.txt.' },
      { role: 'user', content: 'The user switched models.\n\nthanks' },
    ]);
    assert.deepEqual(
      input.tools?.map((tool) => tool.name),
      ['shell'],
    );
    assert.equal(input.toolChoice, 'auto');
    assert.equal(input.maxTokens, 100);
    const body = await response.json();
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.model, MODEL);
    assert.deepEqual(
      body.output.map((item: { type: string }) => item.type),
      ['message'],
    );
    assert.equal(body.output[0].content[0].text, 'hello there');
    assert.deepEqual(body.usage, {
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 9,
    });
  } finally {
    await server.close();
  }
});

void test('a whole answer that calls tools has only function_call items; a cut one is incomplete', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(CALLS, seen);
  try {
    const body = await (
      await post(server.url, {
        ...CODEX,
        input: 'list files',
        max_output_tokens: 40,
      })
    ).json();
    assert.equal(seen[0]?.maxTokens, 40);
    assert.deepEqual(
      body.output.map((item: Record<string, string>) => [
        item.type,
        item.call_id,
        item.name,
        item.arguments,
      ]),
      [
        ['function_call', 'call_a', 'shell', '{"command":["ls"]}'],
        ['function_call', 'call_b', 'shell', '{"command":["pwd"]}'],
      ],
    );
  } finally {
    await server.close();
  }
  const cut = await host(
    { ...TEXT, finishReason: ENGINE_DONE_REASONS.LENGTH },
    [],
  );
  try {
    const body = await (await post(cut.url, { ...CODEX, input: 'hi' })).json();
    assert.equal(body.status, 'incomplete');
    assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
  } finally {
    await cut.close();
  }
});

void test('the stream follows the event order Codex parses, text first, then each call, then completed', async () => {
  const server = await host(async (onDelta) => {
    await onDelta('let me ');
    await onDelta('look');
    return { ...CALLS, text: 'let me look' };
  }, []);
  try {
    const response = await post(server.url, {
      ...CODEX,
      stream: true,
      input: 'list files',
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/event-stream/,
    );
    const stream = events(await response.text());
    assert.deepEqual(
      stream.map((event) => event.type),
      [
        'response.created',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.completed',
      ],
    );
    assert.deepEqual(
      stream.map((event) => event.sequence_number),
      stream.map((_, index) => index),
    );
    assert.equal(stream[7].item.content[0].text, 'let me look');
    assert.deepEqual(
      [
        stream[10].output_index,
        stream[10].item.call_id,
        stream[10].item.arguments,
      ],
      [1, 'call_a', '{"command":["ls"]}'],
    );
    const done = stream.at(-1).response;
    assert.equal(done.status, 'completed');
    assert.deepEqual(
      done.output.map((item: { type: string }) => item.type),
      ['message', 'function_call', 'function_call'],
    );
    assert.equal(done.usage.total_tokens, 13);
  } finally {
    await server.close();
  }
});

void test('a turn that only calls tools streams no empty message, and a failure mid-stream is response.failed', async () => {
  const calls = await host(CALLS, []);
  try {
    const stream = events(
      await (
        await post(calls.url, { ...CODEX, stream: true, input: 'go' })
      ).text(),
    );
    assert.equal(stream[1].item.type, 'function_call');
    assert.ok(!stream.some((event) => event.item?.type === 'message'));
  } finally {
    await calls.close();
  }
  const failing = await host(async (onDelta) => {
    await onDelta('par');
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  }, []);
  try {
    const stream = events(
      await (
        await post(failing.url, { ...CODEX, stream: true, input: 'go' })
      ).text(),
    );
    const failed = stream.at(-1);
    assert.equal(failed.type, 'response.failed');
    assert.equal(failed.response.status, 'failed');
    // Codex retries codes it does not know; this one it shows and stops, with the Gyblos code alongside.
    assert.equal(failed.response.error.code, 'invalid_prompt');
    assert.equal(
      failed.response.error.gyblos_code,
      FREE_BUYER_CODES.UNAVAILABLE,
    );
    assert.match(failed.response.error.message, /Send your message again/);
  } finally {
    await failing.close();
  }
});

const REFUSED: [string, Record<string, unknown>, RegExp][] = [
  ['stored state', { store: true }, /store/],
  [
    'a previous response',
    { previous_response_id: 'resp_1' },
    /previous_response_id/,
  ],
  [
    'structured output',
    { text: { format: { type: 'json_schema', name: 'x', schema: {} } } },
    /text/,
  ],
  ['an unknown option', { frobnicate: 1 }, /field/],
  [
    'a custom tool',
    { tools: [{ type: 'custom', name: 'apply_patch', format: {} }] },
    /custom/,
  ],
  [
    'an MCP namespace',
    { tools: [{ type: 'namespace', name: 'mcp' }] },
    /namespace/,
  ],
  [
    'audio',
    {
      input: [
        { role: 'user', content: [{ type: 'input_audio', file_id: 'f' }] },
      ],
    },
    /only text/,
  ],
  [
    'empty content',
    { input: [{ role: 'user', content: [] }] },
    /input must be/,
  ],
  ['another model', { model: 'gpt-5' }, /model must be/],
];

void test('options, items and tools this endpoint cannot serve are refused by name, before any seller', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    for (const [label, change, message] of REFUSED) {
      const response = await post(server.url, {
        ...CODEX,
        input: [user('hi')],
        ...change,
      });
      assert.equal(response.status, 400, label);
      const body = await response.json();
      assert.equal(body.error.code, 'FREE_BUYER_INVALID_REQUEST', label);
      assert.match(body.error.message, message, label);
    }
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});
