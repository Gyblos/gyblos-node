// The context a buyer announces for a model is the smallest one its eligible sellers list, so a prompt
// sized to it fits whichever of them is chosen; agents read it from /v1/models to size their prompts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { smallestContextTokens } from '@gyblos/core/seller-selection';

import { startFreeBuyerHttp } from '../apps/buyer/src/free-http';
import type { ModelRoute } from '../apps/buyer/src/model-routes';
import {
  MODEL,
  NOW,
  request,
  seller,
} from './support/seller-selection-fixture';

void test('the announced context is the smallest among eligible sellers of the model, cooldown or not', () => {
  const sellers = [
    seller(1, { contextTokens: 32_768 }),
    seller(2, { contextTokens: 16_384 }),
    // Not counted: another model, an expired presence, a price above the ceiling.
    seller(3, { contextTokens: 2048, modelId: 'other-model' }),
    seller(4, { contextTokens: 2048, presence: 'stale' }),
    seller(5, { contextTokens: 2048, input: '1000' }),
  ];
  const stats = new Map([
    [
      sellers[1]!.catalog.nodeId,
      {
        successes: 0,
        failures: 1,
        latencyMs: null,
        waitAccuracy: null,
        cooldownUntil: NOW + 30_000,
      },
    ],
  ]);
  assert.equal(
    smallestContextTokens({ request: request(), sellers, stats, now: NOW }),
    16_384,
  );
  assert.equal(
    smallestContextTokens({
      request: request(),
      sellers: [sellers[2]!],
      stats: new Map(),
      now: NOW,
    }),
    undefined,
  );
});

void test('/v1/models adds context_length when the buyer knows it, and omits it when it does not', async () => {
  const known = new Map([['small', 16_384]]);
  const asked: string[] = [];
  const models: ModelRoute[] = [
    { id: 'small', aliases: [], selection: MODEL, maxTokens: 100 },
    {
      id: 'unknown',
      aliases: [],
      selection: { ...MODEL, modelId: 'other' },
      maxTokens: 200,
    },
  ];
  const server = await startFreeBuyerHttp(
    async () => {
      throw new Error('no chat in this test');
    },
    {
      selection: MODEL,
      maxTokens: 100,
      models,
      contextTokens: async (route) => {
        asked.push(route.id);
        return known.get(route.id);
      },
    },
    { port: 0 },
  );
  try {
    const url = server.url.replace(/\/v1\/chat\/completions$/, '/v1/models');
    const list = await (await fetch(url)).json();
    assert.deepEqual(
      list.data.map((row: Record<string, unknown>) => [
        row.id,
        row.max_output_tokens,
        row.context_length,
      ]),
      [
        ['small', 100, 16_384],
        ['unknown', 200, undefined],
      ],
    );
    assert.deepEqual(asked.sort(), ['small', 'unknown']);
  } finally {
    await server.close();
  }
});

void test('/v1/models still answers when finding the context fails', async () => {
  const server = await startFreeBuyerHttp(
    async () => {
      throw new Error('no chat in this test');
    },
    {
      selection: MODEL,
      maxTokens: 100,
      contextTokens: async () => {
        throw new Error('sellers unreachable');
      },
    },
    { port: 0 },
  );
  try {
    const url = server.url.replace(/\/v1\/chat\/completions$/, '/v1/models');
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const list = await response.json();
    assert.equal(list.data[0].id, MODEL.modelId);
    assert.equal('context_length' in list.data[0], false);
  } finally {
    await server.close();
  }
});
