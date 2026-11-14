// Independent usage checks reject uncertified or unstable billable prefixes before financial approval.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyInferencePrefix } from '@gyblos/inference/conversation';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import { INFERENCE_CODES } from '@gyblos/protocol/inference';

function fixture() {
  const input = {
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
    maxTokens: 10,
  };
  const meter: ChatTokenizer = {
    input: () => 2,
    chat: () => 2,
    count: (text) => text.length,
    stablePrefix: (text) => ({
      characters: text.length - 1,
      tokens: text.length - 1,
    }),
  };
  return { input, meter };
}
void test('an observed boundary space is delivered but excluded from the current certified usage', () => {
  const { input, meter } = fixture();
  assert.deepEqual(verifyInferencePrefix(input, 'aa ', meter), {
    inputTokens: 2,
    outputTokens: 2,
  });
});
void test('prefix verification requires both the tokenizer certificate and its delivered guard space', () => {
  const { input, meter } = fixture();
  assert.throws(() => verifyInferencePrefix(input, 'aa', meter), {
    code: INFERENCE_CODES.UNSUPPORTED,
  });
  delete meter.stablePrefix;
  assert.throws(() => verifyInferencePrefix(input, 'aa ', meter), {
    code: INFERENCE_CODES.UNSUPPORTED,
  });
});
void test('a frontier after the observed space cannot authorize a changing BPE suffix', () => {
  const { input, meter } = fixture();
  meter.stablePrefix = () => ({ characters: 3, tokens: 3 });
  assert.throws(() => verifyInferencePrefix(input, 'aa ', meter), {
    code: INFERENCE_CODES.INVALID,
  });
});
void test('unsafe input counts, nonpositive output counts and output beyond the request limit are rejected', () => {
  for (const tokens of [-1, 0, 11, Number.NaN]) {
    const { input, meter } = fixture();
    meter.stablePrefix = () => ({ characters: 2, tokens });
    assert.throws(() => verifyInferencePrefix(input, 'aa ', meter), {
      code: INFERENCE_CODES.INVALID,
    });
  }
  const { input, meter } = fixture();
  meter.chat = () => Number.NaN;
  assert.throws(() => verifyInferencePrefix(input, 'aa ', meter), {
    code: INFERENCE_CODES.INVALID,
  });
});
