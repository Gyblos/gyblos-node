// The Qwen3 hybrid family shares one public tokenizer and chat template: every member's tokenizer.json and
// tokenizer_config.json hash to the pinned pair the recount uses, so each is recountable. A model without
// that pin is not. Pure.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL } from '@gyblos/engine-ollama/constants';
import { MODEL_CLASSIFICATIONS, MODEL_IDS } from '@gyblos/protocol/constants';
import {
  MODEL_CATALOG,
  resolveModel,
  usesPinnedTokenizer,
} from '@gyblos/protocol/models';

const QWEN3 = [
  MODEL_IDS.QWEN3_0_6B,
  MODEL_IDS.QWEN3_1_7B,
  MODEL_IDS.QWEN3_4B,
  MODEL_IDS.QWEN3_8B,
  MODEL_IDS.QWEN3_14B,
  MODEL_IDS.QWEN3_32B,
  MODEL_IDS.QWEN3_30B_A3B,
  MODEL_IDS.QWEN3_235B_A22B,
];

void test('every Qwen3 hybrid model pins the recount tokenizer and is recountable', () => {
  for (const id of QWEN3) {
    const entry = MODEL_CATALOG.find((model) => model.id === id);
    assert.ok(entry?.tokenizer, id);
    assert.equal(entry.tokenizer.sha256, MODEL.tokenizerSha256, id);
    assert.equal(entry.tokenizer.configSha256, MODEL.configSha256, id);
    assert.match(entry.tokenizer.repository, /^Qwen\/Qwen3-/, id);
    assert.match(entry.tokenizer.revision, /^[0-9a-f]{40}$/, id);
    assert.equal(usesPinnedTokenizer(id), true, id);
  }
});

void test('Ollama tags resolve to the catalog models', () => {
  for (const [tag, id] of [
    ['qwen3:1.7b', MODEL_IDS.QWEN3_1_7B],
    ['qwen3:8b', MODEL_IDS.QWEN3_8B],
    ['qwen3:14b', MODEL_IDS.QWEN3_14B],
    ['qwen3:32b', MODEL_IDS.QWEN3_32B],
  ] as const) {
    const resolved = resolveModel(tag);
    assert.equal(resolved.kind, MODEL_CLASSIFICATIONS.CATALOG, tag);
    assert.equal(
      resolved.kind === MODEL_CLASSIFICATIONS.CATALOG && resolved.model.id,
      id,
    );
  }
});

void test('a model without the pinned tokenizer is not recountable', () => {
  assert.equal(usesPinnedTokenizer(MODEL_IDS.GPT_OSS_20B), false);
  assert.equal(usesPinnedTokenizer('acme/chat-small'), false);
});
