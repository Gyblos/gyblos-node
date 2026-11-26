import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { readIndex } from '@gyblos/explorer/discovery';
import { snapshotOf } from '@gyblos/explorer/discovery-snapshot';
import { modelMatches } from '@gyblos/explorer/entity-search';
import {
  modelMaker,
  modelView,
  parseCatalogModels,
} from '@gyblos/explorer/model-catalog';

import { fakeIndex } from './support/explorer-discovery';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const catalogBody = {
  generatedAt: 7,
  models: [
    {
      id: 'qwen3-0.6b',
      sellers: 2,
      family: 'qwen',
      lab: 'Alibaba · Qwen',
      source: 'registry',
      categories: ['general', 'reasoning', 'poetry'],
    },
    {
      id: 'acme/mystery-7b',
      sellers: 1,
      family: 'other',
      lab: 'acme',
      source: 'fallback',
      categories: [],
    },
    {
      id: 'meta-llama/x',
      sellers: 1,
      family: 'not-a-family',
      lab: 'Meta',
      source: 'rules',
    },
  ],
};

void test('the catalog answer becomes each model family, lab and categories', () => {
  const models = parseCatalogModels(catalogBody);
  assert.deepEqual(Object.keys(models), [
    'qwen3-0.6b',
    'acme/mystery-7b',
    'meta-llama/x',
  ]);
  assert.deepEqual(modelView(models, 'qwen3-0.6b'), {
    family: 'qwen',
    familyName: 'Qwen',
    lab: 'Alibaba · Qwen',
    categories: ['general', 'reasoning'],
    classified: true,
  });
  assert.deepEqual(modelView(models, 'acme/mystery-7b'), {
    family: null,
    familyName: null,
    lab: 'acme',
    categories: [],
    classified: false,
  });
  assert.deepEqual(modelView(models, 'meta-llama/x'), {
    family: null,
    familyName: null,
    lab: 'Meta',
    categories: [],
    classified: false,
  });
  assert.throws(() => parseCatalogModels({ models: {} }));
});

void test('a model the catalog does not list falls back to the rules', () => {
  assert.deepEqual(modelView({}, 'unsloth/Qwen3-8B-GGUF'), {
    family: 'qwen',
    familyName: 'Qwen',
    lab: 'Alibaba · Qwen',
    categories: [],
    classified: false,
  });
  assert.deepEqual(modelView(undefined, 'mystery'), {
    family: null,
    familyName: null,
    lab: 'Unknown',
    categories: [],
    classified: false,
  });
});

void test('the scheduled read takes model identities from /models/catalog into the snapshot', async () => {
  const { requests } = fakeIndex({
    models: { 'qwen3-0.6b': ['a'.repeat(64)] },
    catalog: {
      'qwen3-0.6b': {
        family: 'qwen',
        lab: 'Qwen Team',
        source: 'registry',
        categories: ['coding'],
      },
    },
  });
  const { stored } = await readIndex(null, Date.now);
  assert.ok(requests.includes('/v1/models/catalog'), requests.join(' '));
  assert.ok(!requests.includes('/v1/models'));
  const snapshot = snapshotOf(stored, Date.now());
  assert.deepEqual(modelView(snapshot.models, 'qwen3-0.6b'), {
    family: 'qwen',
    familyName: 'Qwen',
    lab: 'Qwen Team',
    categories: ['coding'],
    classified: true,
  });
});

void test('search matches a model by lab, family name and category', () => {
  const models = parseCatalogModels(catalogBody);
  const model = { modelId: 'qwen3-0.6b', variant: null, quantization: null };
  for (const term of ['alibaba', 'qwen', 'reasoning'])
    assert.ok(modelMatches(model, term, models), term);
  assert.ok(!modelMatches(model, 'coding', models));
  assert.ok(
    !modelMatches(
      { modelId: 'acme/mystery-7b', variant: null, quantization: null },
      'known',
      models,
    ),
  );
});

void test('the heading names the family only when the lab does not already', () => {
  assert.equal(modelMaker(modelView({}, 'qwen3-8b')), 'Alibaba · Qwen');
  assert.equal(
    modelMaker(modelView({}, 'meta-llama/Llama-3.1-8B')),
    'Meta · Llama',
  );
  assert.equal(
    modelMaker(modelView({}, 'google/gemma-3-4b')),
    'Google DeepMind · Gemma',
  );
  assert.equal(modelMaker(modelView({}, 'acme/x')), 'acme');
});
