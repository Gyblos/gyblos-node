// One buyer endpoint serving several models by name: the selection.json `models` list, the model list clients
// read, routing each request (and its stream) to the named model's selection and answer limit, aliases,
// a clear 404 for a name it does not serve, and the free path quoting the routed model. Injected executors
// and loopback ports only; no seller or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeBuyerFree,
  type FreeBuyerDependencies,
} from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import {
  routedRequest,
  type ModelRoute,
  type RoutedModel,
} from '@gyblos/buyer/model-routes';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { FreeExecutionResult } from '@gyblos/protocol/free-execution';

import { selectionFixture } from './support/buyer-selection';

const SMALL = { modelId: 'qwen3-0.6b', variant: null, quantization: 'Q4_K_M' };
const LARGE = { modelId: 'gpt-oss-20b', variant: null, quantization: null };
const ROUTES: ModelRoute[] = [
  { id: 'qwen3-0.6b', aliases: ['qwen'], selection: SMALL, maxTokens: 100 },
  { id: 'gpt-oss-20b', aliases: [], selection: LARGE, maxTokens: 2000 },
];
const RESULT: FreeExecutionResult = {
  text: 'ok',
  usage: { inputTokens: 3, outputTokens: 1 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};

void test('selection.json may list several models by name; names must be unique and limits bounded', async (t) => {
  const host = await selectionFixture();
  t.after(host.wire.close);
  const models = [
    { id: 'qwen3-0.6b', aliases: ['qwen'], selection: SMALL, maxTokens: 100 },
    { id: 'gpt-oss-20b', selection: LARGE },
  ];
  const config = parseBuyerSelectionConfig({ ...host.config, models });
  assert.deepEqual(config.models, [
    ROUTES[0],
    {
      id: 'gpt-oss-20b',
      aliases: [],
      selection: LARGE,
      maxTokens: config.request.maxTokens,
    },
  ]);
  // Without the list, the single request selection is the one model, as before.
  assert.equal(parseBuyerSelectionConfig(host.config).models, undefined);
  for (const bad of [
    [],
    [models[0], { ...models[1], id: 'qwen' }],
    [{ ...models[0], id: 'has space' }],
    [{ ...models[0], maxTokens: 40_000 }],
    [{ ...models[0], extra: true }],
  ])
    assert.throws(
      () => parseBuyerSelectionConfig({ ...host.config, models: bad }),
      JSON.stringify(bad),
    );
});

void test('a routed request quotes the routed model with its own answer limit', () => {
  const request = {
    selection: SMALL,
    maxTokens: 10,
    reasoning: 'off',
  } as unknown as Parameters<typeof routedRequest>[0];
  assert.deepEqual(routedRequest(request, ROUTES[1]), {
    ...request,
    selection: LARGE,
    maxTokens: 2000,
  });
  assert.equal(routedRequest(request, undefined), request);
});

async function host(seen: (RoutedModel | undefined)[]) {
  const record = async (model?: RoutedModel) => {
    seen.push(model);
    return RESULT;
  };
  return startFreeBuyerHttp(
    (_input, _signal, _onDelta, model) => record(model),
    { selection: SMALL, maxTokens: 100, models: ROUTES },
    {
      port: 0,
      stream: async (_input, _signal, onDelta, model) => {
        await onDelta('ok');
        return record(model);
      },
    },
  );
}
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const base = (url: string) => url.replace(/\/v1\/chat\/completions$/, '');

void test('the endpoint lists every model and routes each request, whole or streamed, by name or alias', async () => {
  const seen: (RoutedModel | undefined)[] = [];
  const server = await host(seen);
  try {
    const list = await (await fetch(`${base(server.url)}/v1/models`)).json();
    assert.deepEqual(
      list.data.map((model: { id: string; max_output_tokens: number }) => [
        model.id,
        model.max_output_tokens,
      ]),
      [
        ['qwen3-0.6b', 100],
        ['gpt-oss-20b', 2000],
      ],
    );
    const messages = [{ role: 'user', content: 'hi' }];
    const large = await (
      await post(server.url, { model: 'gpt-oss-20b', messages })
    ).json();
    assert.equal(large.model, 'gpt-oss-20b');
    assert.equal(seen.at(-1)?.selection.modelId, 'gpt-oss-20b');
    await post(server.url, { model: 'qwen', messages, stream: true });
    assert.equal(seen.at(-1)?.selection.modelId, 'qwen3-0.6b');
    const anthropic = await post(`${base(server.url)}/v1/messages`, {
      model: 'gpt-oss-20b',
      max_tokens: 5000,
      messages,
    });
    assert.equal(anthropic.status, 200);
    assert.equal(seen.at(-1)?.maxTokens, 2000);
  } finally {
    await server.close();
  }
});

void test('a model the endpoint does not serve is a 404 that lists the ones it does, in each format', async () => {
  const seen: (RoutedModel | undefined)[] = [];
  const server = await host(seen);
  try {
    const openai = await post(server.url, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(openai.status, 404);
    const body = await openai.json();
    assert.equal(body.error.code, 'FREE_BUYER_MODEL_NOT_FOUND');
    assert.equal(body.error.param, 'model');
    assert.match(body.error.message, /qwen3-0\.6b, gpt-oss-20b/);
    const anthropic = await post(`${base(server.url)}/v1/messages`, {
      model: 'claude-sonnet',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(anthropic.status, 404);
    assert.equal((await anthropic.json()).error.type, 'not_found_error');
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});

void test('the free path asks selection for the routed model', async () => {
  const asked: unknown[] = [];
  const dependencies: FreeBuyerDependencies = {
    select: async (_excluded, _signal, needs) => {
      asked.push(needs);
      throw new Error('stop after selection');
    },
    execute: async () => RESULT,
  };
  await assert.rejects(
    executeBuyerFree(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 },
      dependencies,
      undefined,
      undefined,
      ROUTES[1],
    ),
  );
  assert.deepEqual(asked, [{ tools: false, model: ROUTES[1] }]);
});
