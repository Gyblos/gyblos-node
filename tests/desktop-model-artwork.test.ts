// Checks local visual labels without claiming model or provider verification.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelArtwork } from '@gyblos/desktop/announced-models';

void test('local and namespaced models use the same lab artwork as the catalog', () => {
  assert.equal(
    modelArtwork('qwen3:0.6b').src,
    './assets/models/qwen-color.svg',
  );
  assert.equal(
    modelArtwork('openai/gpt-oss:20b').src,
    './assets/models/openai.svg',
  );
  assert.equal(modelArtwork('unknown').src, './assets/brand/gyblos-icon.png');
  assert.equal(modelArtwork('gpt-neox').src, './assets/brand/gyblos-icon.png');
  assert.equal(modelArtwork('gpt-4o').src, './assets/models/openai.svg');
  assert.equal(
    modelArtwork('claude-3.5-sonnet').src,
    './assets/models/claude-color.svg',
  );
  assert.equal(
    modelArtwork('gemini-2.5-pro').src,
    './assets/models/gemini-color.svg',
  );
  assert.equal(
    modelArtwork('mistral-large').src,
    './assets/models/mistral-color.svg',
  );
});
