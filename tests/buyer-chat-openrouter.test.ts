// Clients written for OpenRouter (or any OpenAI-compatible router) pointed at the local endpoint: their routing
// and sampling extras are accepted and ignored, stop sequences are honored by the buyer, a `models` fallback
// list picks the first model served, and OpenRouter-style names find the same model. Injected executors and
// loopback ports only; no seller, network or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFreeChat } from '@gyblos/buyer/free-chat';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import type { RoutedModel } from '@gyblos/buyer/model-routes';
import {
  ENGINE_DONE_REASONS,
  type FreeChatRole,
} from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { TOOL_CALLS_DONE } from '@gyblos/protocol/tools';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const ASK = [{ role: 'user', content: 'hi' }];
const USAGE = { inputTokens: 7, outputTokens: 9 };

type Result = {
  text: string;
  usage: typeof USAGE;
  finishReason: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
};
interface Seen {
  input: FreeExecutionBuildInput;
  model?: RoutedModel;
}

function host(
  result: Result,
  fragments: string[],
  seen: Seen[] = [],
  models?: {
    id: string;
    aliases: string[];
    selection: typeof SELECTION;
    maxTokens: number;
  }[],
) {
  return startFreeBuyerHttp(
    async (input, _signal, _permission, model) => {
      seen.push({ input, model });
      return result as never;
    },
    {
      selection: SELECTION,
      maxTokens: 10,
      tools: true,
      ...(models ? { models } : {}),
    },
    {
      port: 0,
      stream: async (input, _signal, onDelta, model) => {
        seen.push({ input, model });
        for (const fragment of fragments) await onDelta(fragment);
        return result as never;
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
function events(text: string) {
  return text
    .split('\n\n')
    .filter((block) => block.includes('data: {'))
    .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)));
}

void test('OpenRouter routing and sampling extras are accepted, ignored and never sent to a seller', () => {
  const input = parseFreeChat(
    {
      model: 'synthetic',
      messages: ASK,
      provider: {
        sort: 'price',
        max_price: { prompt: 1 },
        allow_fallbacks: true,
      },
      route: 'fallback',
      transforms: ['middle-out'],
      usage: { include: true },
      debug: { echo_upstream_body: false },
      top_k: 40,
      min_p: 0.05,
      top_a: 0,
      repetition_penalty: 1.1,
      reasoning: { effort: 'low', exclude: true },
      verbosity: 'low',
      prediction: { type: 'content', content: 'x' },
      plugins: [],
    },
    SELECTION,
    10,
  );
  assert.deepEqual(input, {
    messages: [{ role: 'user' as FreeChatRole, content: 'hi' }],
    maxTokens: 10,
  });
});

void test('a plugin or web search option is refused, never silently skipped', () => {
  for (const change of [
    { plugins: [{ id: 'web' }] },
    { web_search_options: { search_context_size: 'low' } },
  ])
    assert.throws(
      () =>
        parseFreeChat(
          { model: 'synthetic', messages: ASK, ...change },
          SELECTION,
          10,
        ),
      /FREE_BUYER_INVALID_REQUEST/,
    );
});

void test('stop is a string or a short list of non-empty strings', () => {
  const parse = (stop: unknown) =>
    parseFreeChat({ model: 'synthetic', messages: ASK, stop }, SELECTION, 10);
  assert.deepEqual(parse('END').stop, ['END']);
  assert.deepEqual(parse(['A', 'B']).stop, ['A', 'B']);
  assert.equal(parse([]).stop, undefined);
  assert.equal(parse(null).stop, undefined);
  for (const bad of [
    '',
    [''],
    [1],
    ['a', 'b', 'c', 'd', 'e'],
    'x'.repeat(300),
    {},
  ])
    assert.throws(() => parse(bad), /FREE_BUYER_INVALID_REQUEST/);
});

void test('an OpenAI answer ends before its stop sequence, and the seller never sees stop', async () => {
  const seen: Seen[] = [];
  const server = await host(
    {
      text: 'hello END world',
      usage: USAGE,
      finishReason: TOOL_CALLS_DONE,
      toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }],
    },
    [],
    seen,
  );
  try {
    const response = await post(server.url, {
      model: 'synthetic',
      messages: ASK,
      stop: ['END', 'zzz'],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'hello ');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.tool_calls, undefined);
    // OpenRouter's SDK refuses a completion without it; OpenAI sends null.
    assert.equal(body.system_fingerprint, null);
    assert.equal(Object.hasOwn(seen[0]!.input, 'stop'), false);
  } finally {
    await server.close();
  }
});

void test('an answer without its stop sequence is untouched', async () => {
  const server = await host(
    { text: 'hello', usage: USAGE, finishReason: ENGINE_DONE_REASONS.LENGTH },
    [],
  );
  try {
    const body = await (
      await post(server.url, { model: 'synthetic', messages: ASK, stop: 'END' })
    ).json();
    assert.equal(body.choices[0].message.content, 'hello');
    assert.equal(body.choices[0].finish_reason, 'length');
  } finally {
    await server.close();
  }
});

void test('a streamed answer stops at a sequence split across fragments and shows nothing after it', async () => {
  const server = await host(
    {
      text: 'hello END world',
      usage: USAGE,
      finishReason: ENGINE_DONE_REASONS.LENGTH,
    },
    ['hel', 'lo E', 'ND wor', 'ld'],
  );
  try {
    const response = await post(server.url, {
      model: 'synthetic',
      messages: ASK,
      stream: true,
      stop: 'END',
    });
    const chunks = events(await response.text());
    const text = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
      .join('');
    assert.equal(text, 'hello ');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  } finally {
    await server.close();
  }
});

void test('a stream whose text only looks like a stop sequence shows all of it', async () => {
  const server = await host(
    {
      text: 'say EN then D',
      usage: USAGE,
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
    ['say E', 'N', ' then D'],
  );
  try {
    const response = await post(server.url, {
      model: 'synthetic',
      messages: ASK,
      stream: true,
      stop: ['END'],
    });
    const chunks = events(await response.text());
    assert.equal(
      chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join(''),
      'say EN then D',
    );
  } finally {
    await server.close();
  }
});

void test('Anthropic stop_sequences end the answer and name the sequence, whole and streamed', async () => {
  const server = await host(
    {
      text: 'one STOP two',
      usage: USAGE,
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
    ['one ST', 'OP two'],
  );
  const url = `${base(server.url)}/v1/messages`;
  const ask = {
    model: 'synthetic',
    max_tokens: 5,
    messages: ASK,
    stop_sequences: ['STOP'],
  };
  try {
    const whole = await (await post(url, ask)).json();
    assert.deepEqual(whole.content, [{ type: 'text', text: 'one ' }]);
    assert.equal(whole.stop_reason, 'stop_sequence');
    assert.equal(whole.stop_sequence, 'STOP');
    const streamed = events(
      await (await post(url, { ...ask, stream: true })).text(),
    );
    assert.equal(
      streamed
        .filter((event) => event.type === 'content_block_delta')
        .map((event) => event.delta.text)
        .join(''),
      'one ',
    );
    const delta = streamed.find((event) => event.type === 'message_delta');
    assert.equal(delta.delta.stop_reason, 'stop_sequence');
    assert.equal(delta.delta.stop_sequence, 'STOP');
  } finally {
    await server.close();
  }
});

const ROUTES = [
  {
    id: 'qwen3-0.6b',
    aliases: [],
    selection: { ...SELECTION, modelId: 'qwen3:0.6b' },
    maxTokens: 10,
  },
  {
    id: 'gpt-oss-20b',
    aliases: ['gpt-oss'],
    selection: { ...SELECTION, modelId: 'gpt-oss:20b' },
    maxTokens: 10,
  },
];

void test('a models fallback list routes to the first model this endpoint serves', async () => {
  const seen: Seen[] = [];
  const server = await host(
    { text: 'ok', usage: USAGE, finishReason: ENGINE_DONE_REASONS.STOP },
    [],
    seen,
    ROUTES,
  );
  try {
    const first = await post(server.url, {
      model: 'openai/gpt-5',
      models: ['anthropic/claude-x', 'gpt-oss'],
      messages: ASK,
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).model, 'gpt-oss');
    assert.equal(seen[0]!.model?.selection.modelId, 'gpt-oss:20b');
    const only = await post(server.url, {
      models: ['qwen3-0.6b'],
      messages: ASK,
    });
    assert.equal(only.status, 200);
    assert.equal(seen[1]!.model?.selection.modelId, 'qwen3:0.6b');
    const none = await post(server.url, {
      model: 'a',
      models: ['b', 'c'],
      messages: ASK,
    });
    assert.equal(none.status, 404);
    assert.match((await none.json()).error.message, /qwen3-0\.6b, gpt-oss-20b/);
    for (const models of ['x', [1], Array.from({ length: 40 }, () => 'x')])
      assert.equal(
        (await post(server.url, { model: 'qwen3-0.6b', models, messages: ASK }))
          .status,
        400,
      );
  } finally {
    await server.close();
  }
});

void test('OpenRouter-style names find the same model, with a provider prefix or a routing suffix', async () => {
  const seen: Seen[] = [];
  const server = await host(
    { text: 'ok', usage: USAGE, finishReason: ENGINE_DONE_REASONS.STOP },
    [],
    seen,
    ROUTES,
  );
  try {
    for (const name of [
      'qwen/qwen3-0.6b',
      'qwen/qwen3-0.6b:free',
      'qwen3-0.6b:nitro',
    ]) {
      const response = await post(server.url, { model: name, messages: ASK });
      assert.equal(response.status, 200, name);
      assert.equal((await response.json()).model, name);
      assert.equal(seen.at(-1)!.model?.selection.modelId, 'qwen3:0.6b');
    }
    // A suffix that would change the answer (web search) is not a name for the plain model.
    assert.equal(
      (
        await post(server.url, {
          model: 'qwen/qwen3-0.6b:online',
          messages: ASK,
        })
      ).status,
      404,
    );
  } finally {
    await server.close();
  }
  const single = await host(
    { text: 'ok', usage: USAGE, finishReason: ENGINE_DONE_REASONS.STOP },
    [],
  );
  try {
    const response = await post(single.url, {
      model: 'gyblos/synthetic',
      messages: ASK,
    });
    assert.equal(response.status, 200);
  } finally {
    await single.close();
  }
});
