// The anthropic engine plugin: which offers it serves (an API key, https anywhere or a literal loopback
// proxy at the API root, reasoning off), declared usage, readiness by describing the model (never
// generating, even on loopback) and where its key goes. Offline, synthetic values.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

const OFFER: SellerEngineOffer = {
  index: 0,
  model: { kind: MODEL_CLASSIFICATIONS.CUSTOM, id: 'acme/chat-large' },
  engine: {
    kind: ENGINE_KINDS.ANTHROPIC,
    url: 'https://api.anthropic.example',
    apiKeyEnv: 'ANTHROPIC_UPSTREAM_KEY',
    upstreamModel: 'acme-chat-large-2026',
    contextTokens: 200_000,
  },
  reasoning: [REASONING_LEVELS.OFF],
};
const withUrl = (url: string): SellerEngineOffer => ({
  ...OFFER,
  engine: { ...OFFER.engine, url },
});

void test('anthropic serves https or a literal loopback proxy at the API root, with a key and reasoning off', () => {
  for (const url of [
    'https://api.anthropic.example',
    'https://proxy.example/anthropic',
    'http://127.0.0.1:8080',
  ])
    assert.equal(engineOfferRefusal(withUrl(url)), undefined, url);
  for (const url of [
    'http://localhost:8080',
    'https://api.anthropic.example/v1',
    'https://api.anthropic.example/v1/',
    'https://api.anthropic.example?',
    'https://api.anthropic.example/v1/messages',
    'https://proxy.example/v1/anthropic',
  ])
    assert.equal(
      engineOfferRefusal(withUrl(url)),
      NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
      url,
    );
  const { apiKeyEnv: _key, ...keyless } = OFFER.engine;
  assert.equal(
    engineOfferRefusal({ ...OFFER, engine: keyless }),
    NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING,
  );
  for (const upstreamModel of ['.', '..'])
    assert.equal(
      engineOfferRefusal({
        ...OFFER,
        engine: { ...OFFER.engine, upstreamModel },
      }),
      NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED,
      upstreamModel,
    );
  assert.equal(
    engineOfferRefusal({ ...OFFER, reasoning: [REASONING_LEVELS.HIGH] }),
    NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
  );
});

void test('an anthropic engine is declared, only described for readiness, and sends its key to its model', async () => {
  for (const url of [
    'https://api.anthropic.example',
    'http://127.0.0.1:8080',
  ]) {
    const requests: { url: string; key: string | null }[] = [];
    const prepared = createSellerEngine(withUrl(url), {
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          key: new Headers(init?.headers).get('x-api-key'),
        });
        return new Response(JSON.stringify({ id: 'acme-chat-large-2026' }));
      },
      environment: { ANTHROPIC_UPSTREAM_KEY: FAKE_SECRET },
    });
    assert.equal(requests.length, 0);
    assert.deepEqual(prepared.selection, {
      modelId: 'acme/chat-large',
      variant: null,
      quantization: null,
    });
    assert.equal(prepared.metering.mode, CONTROL_METERING_MODES.DECLARED);
    assert.deepEqual(prepared.readiness, REMOTE_READINESS, url);
    await prepared.engine.describe();
    assert.deepEqual(requests, [
      { url: `${url}/v1/models/acme-chat-large-2026`, key: FAKE_SECRET },
    ]);
  }
});

void test('examples/anthropic-free.toml is a file the seller daemon serves as written', () => {
  const parsed = parseNodeConfig(
    readFileSync(join(REPOSITORY_ROOT, 'examples/anthropic-free.toml'), 'utf8'),
  );
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const environment = { ANTHROPIC_API_KEY: FAKE_SECRET };
  const [offer] = sellerSettings(parsed.config, environment).offers;
  assert.equal(offer!.engine.engine.kind, ENGINE_KINDS.ANTHROPIC);
  assert.throws(
    () => sellerSettings(parsed.config, {}),
    (error: unknown) =>
      error instanceof NodeError &&
      error.code === NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING,
  );
});
