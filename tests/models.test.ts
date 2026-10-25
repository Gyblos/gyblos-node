// Exercises explicit model aliases and truthful metadata without contacting engines.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { MODEL_CATALOG, resolveModel } from '@gyblos/protocol/models';

void test('canonical model catalog contains the website IDs plus the small offline-test model', () => {
  assert.deepEqual(
    MODEL_CATALOG.map((model) => model.id),
    [
      'qwen3-30b-a3b',
      'qwen3-235b-a22b',
      'deepseek-v4.1-flash',
      'kimi-k3',
      'glm-5.3-flash',
      'gpt-oss-120b',
      'gpt-oss-20b',
      'llama-3.3-70b',
      'gemma-4-26b',
      'qwen3-0.6b',
    ],
  );
  const ids = new Set<string>();
  for (const model of MODEL_CATALOG) {
    for (const id of [model.id, ...model.aliases]) {
      assert.ok(!ids.has(id), 'Canonical IDs and aliases must be unambiguous.');
      ids.add(id);
      assert.deepEqual(resolveModel(id), {
        kind: MODEL_CLASSIFICATIONS.CATALOG,
        model,
      });
    }
    assert.equal(model.openWeights, null);
    assert.ok(Object.isFrozen(model));
    assert.ok(Object.isFrozen(model.aliases));
  }
});

void test('model alias matching is explicit, preserves variants and accepts custom IDs', () => {
  const resolved = resolveModel('qwen3:0.6b');
  assert.equal(resolved.kind, MODEL_CLASSIFICATIONS.CATALOG);
  if (resolved.kind === MODEL_CLASSIFICATIONS.CATALOG)
    assert.equal(resolved.model.id, MODEL_IDS.QWEN3_0_6B);
  for (const id of [
    'custom-model',
    'Qwen/Qwen3-0.6B',
    'QWEN3-0.6B',
    'qwen3:0.6b-q8_0',
    'gpt-oss-20b-other',
  ])
    assert.deepEqual(resolveModel(id), {
      kind: MODEL_CLASSIFICATIONS.CUSTOM,
      modelId: id,
    });
  for (const invalid of ['', 'https://private.example/model', 'a'.repeat(129)])
    assert.throws(() => resolveModel(invalid), {
      code: 'INVALID_PUBLIC_RECORD',
    });
});

void test('unknown tokenizer metadata stays explicit; the known tiny tokenizer is pinned without a verification badge', () => {
  for (const model of MODEL_CATALOG.filter(
    (model) => model.id !== MODEL_IDS.QWEN3_0_6B,
  ))
    assert.equal(model.tokenizer, null);
  const tiny = resolveModel(MODEL_IDS.QWEN3_0_6B);
  assert.equal(tiny.kind, MODEL_CLASSIFICATIONS.CATALOG);
  if (tiny.kind !== MODEL_CLASSIFICATIONS.CATALOG) return;
  assert.deepEqual(tiny.model.tokenizer, {
    repository: 'Qwen/Qwen3-0.6B',
    revision: 'c1899de289a04d12100db370d81485cdf75e47ca',
    sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
  });
  assert.ok(Object.isFrozen(tiny.model.tokenizer));
});

void test('catalog reasoning entries list valid, unique, ordered levels with the default in the set', () => {
  const order: readonly string[] = Object.values(REASONING_LEVELS);
  for (const model of MODEL_CATALOG) {
    if (model.reasoning === null) continue;
    const { levels, defaultReasoning } = model.reasoning;
    assert.ok(levels.length > 0, model.id);
    assert.equal(new Set(levels).size, levels.length, model.id);
    for (const level of levels) assert.ok(order.includes(level), model.id);
    assert.deepEqual(
      [...levels].sort(
        (left, right) => order.indexOf(left) - order.indexOf(right),
      ),
      [...levels],
      model.id,
    );
    assert.ok(levels.includes(defaultReasoning), model.id);
    assert.ok(Object.isFrozen(model.reasoning), model.id);
    assert.ok(Object.isFrozen(levels), model.id);
  }
});

void test('catalog reasoning levels follow primary model sources; unverified models stay null', () => {
  const expected: Record<string, unknown> = {
    'qwen3-30b-a3b': { levels: ['off', 'high'], defaultReasoning: 'off' },
    'qwen3-235b-a22b': { levels: ['off', 'high'], defaultReasoning: 'off' },
    'deepseek-v4.1-flash': null,
    'kimi-k3': null,
    'glm-5.3-flash': null,
    'gpt-oss-120b': {
      levels: ['low', 'medium', 'high'],
      defaultReasoning: 'low',
    },
    'gpt-oss-20b': {
      levels: ['low', 'medium', 'high'],
      defaultReasoning: 'low',
    },
    'llama-3.3-70b': { levels: ['off'], defaultReasoning: 'off' },
    'gemma-4-26b': { levels: ['off', 'high'], defaultReasoning: 'off' },
    'qwen3-0.6b': { levels: ['off', 'high'], defaultReasoning: 'off' },
  };
  assert.deepEqual(
    Object.fromEntries(
      MODEL_CATALOG.map((model) => [model.id, model.reasoning]),
    ),
    expected,
  );
});

void test('alias resolution keeps the catalog reasoning levels', () => {
  for (const [alias, id] of [
    ['qwen3:0.6b', MODEL_IDS.QWEN3_0_6B],
    ['qwen3:30b-a3b-q4_K_M', MODEL_IDS.QWEN3_30B_A3B],
  ] as const) {
    const byAlias = resolveModel(alias);
    const byId = resolveModel(id);
    assert.equal(byAlias.kind, MODEL_CLASSIFICATIONS.CATALOG);
    assert.equal(byId.kind, MODEL_CLASSIFICATIONS.CATALOG);
    if (
      byAlias.kind !== MODEL_CLASSIFICATIONS.CATALOG ||
      byId.kind !== MODEL_CLASSIFICATIONS.CATALOG
    )
      return;
    assert.deepEqual(byAlias.model.reasoning, {
      levels: [REASONING_LEVELS.OFF, REASONING_LEVELS.HIGH],
      defaultReasoning: REASONING_LEVELS.OFF,
    });
    assert.equal(byAlias.model.reasoning, byId.model.reasoning);
  }
});
