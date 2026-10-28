// The openai engine plugin: which offers it serves (https anywhere or a literal loopback server,
// reasoning off), how it counts (recounted only for a model whose public tokenizer is pinned), how it
// proves readiness (a local server warms up, a remote API is only described) and where its API key
// comes from. Settings refuse an offer whose key variable is unset. Offline, synthetic values.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import {
  REMOTE_READINESS,
  type SellerEngineOffer,
} from '@gyblos/node/engine-factory';
import {
  createSellerEngine,
  engineOfferRefusal,
} from '@gyblos/node/engine-registry';
import { NodeError } from '@gyblos/node/errors';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';
import {
  CONTROL_METERING_MODES,
  ENGINE_KINDS,
  MODEL_CLASSIFICATIONS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { BASE, FAKE_SECRET } from './support/node-config-fixtures';

const REMOTE: SellerEngineOffer = {
  index: 0,
  model: { kind: MODEL_CLASSIFICATIONS.CUSTOM, id: 'acme/chat-small' },
  engine: {
    kind: ENGINE_KINDS.OPENAI,
    url: 'https://api.example.com/v1',
    apiKeyEnv: 'UPSTREAM_API_KEY',
    upstreamModel: 'acme-chat-small-2026',
    contextTokens: 131_072,
  },
  reasoning: [REASONING_LEVELS.OFF],
};
const LOCAL: SellerEngineOffer = {
  ...REMOTE,
  model: {
    kind: MODEL_CLASSIFICATIONS.CATALOG,
    id: 'qwen3-0.6b',
    requested: 'qwen3:0.6b',
  },
  engine: {
    kind: ENGINE_KINDS.OPENAI,
    url: 'http://127.0.0.1:1234/v1',
    contextTokens: 32_768,
  },
};

void test('openai serves https anywhere or a literal loopback server, with reasoning off', () => {
  assert.equal(engineOfferRefusal(REMOTE), undefined);
  assert.equal(engineOfferRefusal(LOCAL), undefined);
  assert.equal(
    engineOfferRefusal({
      ...LOCAL,
      engine: { ...LOCAL.engine, url: 'http://[::1]:1234/v1' },
    }),
    undefined,
  );
  // Names wait for gyblos init (PR 8), as for Ollama.
  for (const url of [
    'http://localhost:1234/v1',
    'http://host.docker.internal:1234/v1',
  ])
    assert.equal(
      engineOfferRefusal({ ...LOCAL, engine: { ...LOCAL.engine, url } }),
      NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
      url,
    );
  const { contextTokens: _omitted, ...withoutContext } = REMOTE.engine;
  assert.equal(
    engineOfferRefusal({ ...REMOTE, engine: withoutContext }),
    NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
  );
  for (const reasoning of [
    [REASONING_LEVELS.LOW],
    [REASONING_LEVELS.OFF, REASONING_LEVELS.HIGH],
    [],
  ])
    assert.equal(
      engineOfferRefusal({ ...REMOTE, reasoning }),
      NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
    );
});

void test('a remote openai engine is declared, described for readiness and carries its key only to its URL', async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const prepared = createSellerEngine(REMOTE, {
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(
        JSON.stringify({ data: [{ id: 'acme-chat-small-2026' }] }),
      );
    },
    environment: { UPSTREAM_API_KEY: FAKE_SECRET },
  });
  assert.equal(requests.length, 0);
  assert.deepEqual(prepared.selection, {
    modelId: 'acme/chat-small',
    variant: null,
    quantization: null,
  });
  assert.equal(prepared.metering.mode, CONTROL_METERING_MODES.DECLARED);
  assert.deepEqual(prepared.readiness, REMOTE_READINESS);
  assert.equal(prepared.engine.capabilities().recountable, false);
  assert.deepEqual(await prepared.engine.describe(), {
    name: 'acme-chat-small-2026',
    contextTokens: 131_072,
  });
  assert.deepEqual(requests, [
    {
      url: 'https://api.example.com/v1/models',
      authorization: `Bearer ${FAKE_SECRET}`,
    },
  ]);
});

void test('a loopback openai server serving a pinned-tokenizer model is recounted and warmed locally', () => {
  const prepared = createSellerEngine(LOCAL, {
    fetch: globalThis.fetch,
    environment: {},
  });
  assert.equal(prepared.metering.mode, CONTROL_METERING_MODES.RECOUNTED);
  assert.equal(prepared.engine.capabilities().recountable, true);
  assert.equal(prepared.readiness.localResources, true);
  assert.ok(prepared.readiness.warmup);
});

const remoteToml = (env = 'UPSTREAM_API_KEY') =>
  BASE +
  [
    '[[offers]]',
    'model = "acme/chat-small"',
    'custom = true',
    'reasoning = ["off"]',
    `engine = { kind = "openai", url = "https://api.example.com/v1", api_key_env = "${env}", context_tokens = 131072 }`,
    'free = { daily_token_cap = 20000, per_buyer_cap = 2000 }',
    '',
  ].join('\n');

void test('settings refuse an offer whose API key variable is unset or empty, naming the offer', () => {
  const parsed = parseNodeConfig(remoteToml());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  for (const environment of [{}, { UPSTREAM_API_KEY: '' }])
    assert.throws(
      () => sellerSettings(parsed.config, environment),
      (error: unknown) =>
        error instanceof NodeError &&
        error.code === NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING &&
        error.offer === 0 &&
        !error.message.includes('UPSTREAM_API_KEY'),
    );
  const settings = sellerSettings(parsed.config, {
    UPSTREAM_API_KEY: FAKE_SECRET,
  });
  assert.equal(settings.offers[0]!.engine.engine.kind, ENGINE_KINDS.OPENAI);
  assert.ok(!JSON.stringify(settings).includes(FAKE_SECRET));
});
