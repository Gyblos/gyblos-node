import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { readIndex } from '@gyblos/explorer/discovery';
import { snapshotOf } from '@gyblos/explorer/discovery-snapshot';
import { modelMatches } from '@gyblos/explorer/entity-search';
import {
  modelMaker,
  modelView,
  parseCatalog,
} from '@gyblos/explorer/model-catalog';
import {
  MODEL_IDENTITY_SOURCE,
  OTHER_FAMILY,
  UNKNOWN_LAB,
} from '@gyblos/protocol/model-family';

import { fakeIndex } from './support/explorer-discovery';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const row = (
  id: string,
  family: string,
  lab: string,
  source: string,
  categories?: unknown,
) => ({ id, sellers: 1, family, lab, source, categories });
const catalogBody = {
  generatedAt: 7,
  models: [
    row(
      'qwen3-0.6b',
      'qwen',
      'Alibaba · Qwen',
      MODEL_IDENTITY_SOURCE.REGISTRY,
      ['reasoning', 'general', 'poetry'],
    ),
    row(
      'acme/mystery-7b',
      OTHER_FAMILY,
      'acme',
      MODEL_IDENTITY_SOURCE.FALLBACK,
      ['coding'],
    ),
    row('meta-llama/x', 'not-a-family', 'Meta', MODEL_IDENTITY_SOURCE.RULES, [
      'coding',
    ]),
    row(
      'openai/whisper-large-v3',
      'openai',
      'OpenAI',
      MODEL_IDENTITY_SOURCE.RULES,
    ),
  ],
};

void test('the catalog answer becomes each model family, lab and registry categories', () => {
  const { ids, models } = parseCatalog(catalogBody);
  assert.deepEqual(ids, [
    'qwen3-0.6b',
    'acme/mystery-7b',
    'meta-llama/x',
    'openai/whisper-large-v3',
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
  assert.deepEqual(modelView(models, 'meta-llama/x').categories, []);
  assert.equal(modelView(models, 'meta-llama/x').family, null);
  assert.throws(() => parseCatalog({ models: {} }));
});

void test('a family is named only when the model id names it, unless the registry chose it', () => {
  const whisper = modelView({}, 'openai/whisper-large-v3');
  assert.deepEqual([whisper.family, whisper.familyName], ['openai', null]);
  assert.equal(modelMaker(whisper), 'OpenAI');
  const classified = parseCatalog({
    models: [
      row('acme/chat', 'openai', 'OpenAI', MODEL_IDENTITY_SOURCE.REGISTRY, []),
    ],
  }).models;
  assert.equal(modelView(classified, 'acme/chat').familyName, 'GPT');
  assert.equal(
    modelMaker(modelView({}, 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B')),
    'DeepSeek',
  );
});

void test('model ids that name object members are ordinary ids', () => {
  const { ids, models } = parseCatalog({
    models: [
      row('b', 'qwen', 'Q', MODEL_IDENTITY_SOURCE.RULES),
      row('10', 'qwen', 'Q', MODEL_IDENTITY_SOURCE.RULES),
      row('constructor', 'qwen', 'Q', MODEL_IDENTITY_SOURCE.RULES),
      row('__proto__', 'qwen', 'Proto Lab', MODEL_IDENTITY_SOURCE.RULES),
      row('b', 'qwen', 'Q', MODEL_IDENTITY_SOURCE.RULES),
    ],
  });
  assert.deepEqual(ids, ['b', '10', 'constructor', '__proto__']);
  assert.equal(modelView(models, '__proto__').lab, 'Proto Lab');
  const stored = JSON.parse(JSON.stringify(models)) as typeof models;
  assert.equal(modelView(stored, '__proto__').lab, 'Proto Lab');
  for (const id of ['toString', 'hasOwnProperty', 'valueOf'])
    assert.deepEqual(modelView({}, id), {
      family: null,
      familyName: null,
      lab: UNKNOWN_LAB,
      categories: [],
      classified: false,
    });
});

void test('a model the catalog does not list falls back to the rules', () => {
  assert.deepEqual(modelView({}, 'unsloth/Qwen3-8B-GGUF'), {
    family: 'qwen',
    familyName: 'Qwen',
    lab: 'Alibaba · Qwen',
    categories: [],
    classified: false,
  });
  assert.equal(modelView(undefined, 'acme/metadata-analyzer').lab, 'acme');
  assert.equal(modelView(undefined, 'custom-local-model').lab, UNKNOWN_LAB);
});

void test('the scheduled read takes model identities from /models/catalog into the snapshot', async () => {
  const { requests } = fakeIndex({
    models: { 'qwen3-0.6b': ['a'.repeat(64)] },
    catalog: {
      'qwen3-0.6b': {
        family: 'qwen',
        lab: 'Qwen Team',
        source: MODEL_IDENTITY_SOURCE.REGISTRY,
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
  assert.ok(stored.catalog);
  const { models: _models, ...older } = stored.catalog;
  const previous = snapshotOf({ ...stored, catalog: older }, Date.now());
  assert.deepEqual(previous.models, {});
  assert.equal(modelView(previous.models, 'qwen3-0.6b').lab, 'Alibaba · Qwen');
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

void test('search matches a model by lab, family name and category, never by an unknown lab', () => {
  const { models } = parseCatalog(catalogBody);
  const model = { modelId: 'qwen3-0.6b', variant: null, quantization: null };
  for (const term of ['alibaba', 'qwen', 'reasoning'])
    assert.ok(modelMatches(model, term, models), term);
  assert.ok(!modelMatches(model, 'coding', models));
  const bare = { modelId: 'mystery', variant: null, quantization: null };
  assert.ok(!modelMatches(bare, 'known', models));
  assert.ok(
    !modelMatches(
      { modelId: 'openai/whisper-large-v3', variant: null, quantization: null },
      'gpt',
      models,
    ),
  );
});
