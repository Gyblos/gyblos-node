// The seller's engine registry: settings and startup refuse and create engines only through it. Offer
// refusal keeps the previous order (model, engine, reasoning), creation does no I/O and readiness, metering
// and the listed selection come from the plugin, not from the seller core. Offline, synthetic values.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { READINESS_GENERATION } from '@gyblos/engine-ollama/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import type {
  EngineReadinessPolicy,
  SellerEngineOffer,
} from '@gyblos/node/engine-factory';
import { probeSellerEngine } from '@gyblos/node/engine-readiness';
import {
  ENGINE_REGISTRY,
  engineOfferRefusal,
} from '@gyblos/node/engine-registry';
import { OLLAMA_READINESS } from '@gyblos/node/engine-registry-ollama';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';
import {
  CONTROL_METERING_MODES,
  ENGINE_KINDS,
  MODEL_CLASSIFICATIONS,
  REASONING_LEVELS,
  type EngineKind,
} from '@gyblos/protocol/constants';

import {
  BASE,
  FREE_SELLER_OFFER,
  REPOSITORY_ROOT,
} from './support/node-config-fixtures';

// Any literal loopback URL; the seller runs Ollama there itself.
const ENGINE_URL = 'http://127.0.0.1:11434';
const SERVED: SellerEngineOffer = {
  index: 0,
  model: {
    kind: MODEL_CLASSIFICATIONS.CATALOG,
    id: 'qwen3-0.6b',
    requested: 'qwen3:0.6b',
  },
  engine: { kind: ENGINE_KINDS.OLLAMA, url: ENGINE_URL },
  reasoning: [REASONING_LEVELS.OFF],
};
const OTHER_MODEL = {
  kind: MODEL_CLASSIFICATIONS.CATALOG,
  id: 'gpt-oss-20b',
  requested: 'gpt-oss-20b',
} as const;
const OTHER_ENGINE = {
  kind: ENGINE_KINDS.OLLAMA,
  url: 'http://localhost:11434',
};

void test('the registry names exactly the engines the seller can serve today', () => {
  assert.deepEqual(Object.keys(ENGINE_REGISTRY), [ENGINE_KINDS.OLLAMA]);
});

void test('ollama refusal keeps the previous order: model, then engine, then reasoning', () => {
  assert.equal(engineOfferRefusal(SERVED), undefined);
  assert.equal(
    engineOfferRefusal({
      ...SERVED,
      model: OTHER_MODEL,
      engine: OTHER_ENGINE,
      reasoning: ['high'],
    }),
    NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED,
  );
  assert.equal(
    engineOfferRefusal({
      ...SERVED,
      engine: OTHER_ENGINE,
      reasoning: ['high'],
    }),
    NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
  );
  assert.equal(
    engineOfferRefusal({ ...SERVED, reasoning: ['off', 'high'] }),
    NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
  );
  assert.equal(
    engineOfferRefusal({ ...SERVED, reasoning: [] }),
    NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED,
  );
});

void test('an engine kind without a registered plugin is refused as an unsupported engine', () => {
  assert.equal(
    engineOfferRefusal({
      ...SERVED,
      engine: { kind: ENGINE_KINDS.OPENAI, url: 'https://api.example.com' },
    }),
    NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
  );
});

void test('creating the ollama engine does no I/O and carries its selection, metering and readiness', async () => {
  const requests: string[] = [];
  const prepared = ENGINE_REGISTRY[ENGINE_KINDS.OLLAMA].create(SERVED, {
    fetch: async (input) => {
      requests.push(String(input));
      return new Response('{}', { status: 503 });
    },
    environment: {},
  });
  assert.equal(requests.length, 0);
  assert.deepEqual(prepared.selection, {
    modelId: 'qwen3-0.6b',
    variant: null,
    quantization: MODEL.quantization,
  });
  assert.equal(prepared.metering.mode, CONTROL_METERING_MODES.RECOUNTED);
  assert.deepEqual(prepared.readiness, OLLAMA_READINESS);
  assert.deepEqual(OLLAMA_READINESS, {
    warmup: {
      prompt: READINESS_GENERATION.prompt,
      maxTokens: READINESS_GENERATION.maxTokens,
    },
    residencyMs: READINESS_GENERATION.residencyMs,
    localResources: true,
  });
  // The injected fetch is the engine's transport, at the offer's engine URL.
  await assert.rejects(prepared.engine.describe());
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => url.startsWith(ENGINE_URL)));
});

void test('seller settings carry the engine offer the registry accepted', () => {
  const parsed = parseNodeConfig(BASE + FREE_SELLER_OFFER);
  assert.ok(parsed.ok);
  assert.deepEqual(sellerSettings(parsed.config, {}).offers[0]!.engine, SERVED);
});

void test('control startup and readiness do not know any engine plugin', () => {
  for (const file of ['control-startup.ts', 'engine-readiness.ts'])
    assert.doesNotMatch(
      readFileSync(join(REPOSITORY_ROOT, 'packages/node/src', file), 'utf8'),
      /@gyblos\/engine-/,
    );
});

void test('an engine kind that is only an inherited property name resolves to no plugin', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    // Config parsing admits only ENGINE_KINDS; this simulates a caller that skipped it.
    const kind: string = name;
    assert.equal(
      engineOfferRefusal({
        ...SERVED,
        engine: { ...SERVED.engine, kind: kind as EngineKind },
      }),
      NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
    );
  }
});

void test('a plugin readiness policy whose residency is not beyond the offer lifetime blocks warmup', async () => {
  for (const residencyMs of [
    Number.NaN,
    0,
    OLLAMA_READINESS.residencyMs / 10,
  ]) {
    let generations = 0;
    const policy: EngineReadinessPolicy = { ...OLLAMA_READINESS, residencyMs };
    const prepared = ENGINE_REGISTRY[ENGINE_KINDS.OLLAMA].create(SERVED, {
      fetch: async () => new Response('{}', { status: 503 }),
      environment: {},
    });
    await assert.rejects(
      probeSellerEngine(
        {
          ...prepared.engine,
          describe: async () => ({ name: 'm', digest: 'd', contextTokens: 1 }),
          generate: async () => {
            generations++;
            throw new Error('unreachable');
          },
        },
        new AbortController().signal,
        {
          policy,
          snapshot: async () => ({
            source: 'linux-memavailable',
            vmAvailableBytes: 8 * 1024 ** 3,
            cgroup: null,
          }),
        },
      ),
      /residency/,
    );
    assert.equal(generations, 0);
  }
});
