// The context a buyer announces for a model: the smallest of what the sellers it could use list
// (configured ones at its own prices, open-index ones for free), so a prompt sized to it fits whichever
// is chosen. Agents read it from /v1/models; one read per route serves a short period.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  announcedContext,
  listedContexts,
} from '@gyblos/core/seller-selection';

import {
  cachedRouteContext,
  routeContextTokens,
} from '../apps/buyer/src/free-context';
import { startFreeBuyerHttp } from '../apps/buyer/src/free-http';
import type { ModelRoute } from '../apps/buyer/src/model-routes';
import {
  MODEL,
  nodeId,
  NOW,
  request,
  seller,
} from './support/seller-selection-fixture';

void test('listed contexts are those of eligible sellers of the model, cooldown aside', () => {
  const sellers = [
    seller(1, { contextTokens: 32_768 }),
    seller(2, { contextTokens: 16_384 }),
    // Not counted: another model, an expired presence, a price above the ceiling.
    seller(3, { contextTokens: 2048, modelId: 'other-model' }),
    seller(4, { contextTokens: 2048, presence: 'stale' }),
    seller(5, { contextTokens: 2048, input: '1000' }),
  ];
  assert.deepEqual(
    listedContexts({ request: request(), sellers, now: NOW }),
    [32_768, 16_384],
  );
  assert.deepEqual(
    listedContexts({ request: request(), sellers: [sellers[2]!], now: NOW }),
    [],
  );
});

void test('the announced context is the smallest listed', () => {
  assert.equal(announcedContext([]), undefined);
  assert.equal(announcedContext([131_072, 8192, 16_384]), 8192);
});

void test('a paid buyer announces the context of its paid sellers, with open free sellers counted at zero price', () => {
  const paid = seller(1, { contextTokens: 8192 });
  const openFree = seller(2, {
    contextTokens: 131_072,
    input: '0',
    output: '0',
  });
  const openPaid = seller(3, { contextTokens: 4096 });
  const sellers = [paid, openFree, openPaid];
  const configured = new Set([nodeId(1)]);
  assert.equal(
    routeContextTokens({
      request: request(),
      sellers,
      configured,
      open: true,
      paidAuto: true,
      now: NOW,
    }),
    4096,
  );
  // Paid sellers only: their context, not left out because a free request would not reach them.
  assert.equal(
    routeContextTokens({
      request: request(),
      sellers: [paid],
      configured,
      open: false,
      now: NOW,
    }),
    8192,
  );
  // With open discovery, a free seller the index lists can also serve; an open paid one cannot.
  assert.equal(
    routeContextTokens({
      request: request(),
      sellers,
      configured,
      open: true,
      now: NOW,
    }),
    8192,
  );
  assert.equal(
    routeContextTokens({
      request: request(),
      sellers: [openFree, openPaid],
      configured: new Set(),
      open: true,
      now: NOW,
    }),
    131_072,
  );
});

void test('a route context is computed once per period and shared by requests that arrive together', async () => {
  let clock = NOW;
  let calls = 0;
  let finish: (value: number) => void = () => undefined;
  const context = cachedRouteContext(
    () => {
      calls++;
      return new Promise<number>((resolve) => (finish = resolve));
    },
    { ttlMs: 30_000, timeoutMs: 4000, now: () => clock },
  );
  const route = { selection: MODEL, maxTokens: 100 };
  const signal = new AbortController().signal;
  const first = context(route, signal);
  const second = context(route, signal);
  finish(16_384);
  assert.deepEqual(await Promise.all([first, second]), [16_384, 16_384]);
  assert.equal(await context(route, signal), 16_384);
  assert.equal(calls, 1);
  // Another route is its own entry; after the period the route is read again.
  void context({ selection: MODEL, maxTokens: 200 }, signal);
  assert.equal(calls, 2);
  clock += 30_000;
  void context(route, signal);
  assert.equal(calls, 3);
});

void test('a caller that gives up does not stop the shared read, and a read that found nothing is retried', async () => {
  let calls = 0;
  const context = cachedRouteContext(
    async () => {
      calls++;
      if (calls === 1) throw new Error('sellers unreachable');
      return 16_384;
    },
    { ttlMs: 30_000, timeoutMs: 4000, now: () => NOW },
  );
  const route = { selection: MODEL, maxTokens: 100 };
  assert.equal(await context(route, new AbortController().signal), undefined);
  const leaving = new AbortController();
  leaving.abort();
  assert.equal(await context(route, leaving.signal), undefined);
  assert.equal(await context(route, new AbortController().signal), 16_384);
  assert.equal(await context(route, new AbortController().signal), 16_384);
  assert.equal(calls, 2);
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
