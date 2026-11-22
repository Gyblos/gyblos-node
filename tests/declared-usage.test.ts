// A declared bill is bounded by bytes: no token holds less than one UTF-8 byte (ceiling) and none more than
// declaredMaxTokenBytes (floor). Pure; synthetic inputs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_METERING } from '@gyblos/node/constants';
import { verifyDeclaredUsage } from '@gyblos/node/declared-usage';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { InferenceError } from '@gyblos/protocol/inference';

const input = {
  messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hola' }],
  maxTokens: 500,
} as never;
const result = (
  inputTokens: number,
  outputTokens: number,
  text = 'respuesta',
) => ({ text, usage: { inputTokens, outputTokens } }) as never;
const refused = (run: () => unknown) =>
  assert.throws(run, (error) => error instanceof InferenceError);

void test('a usage within the byte bounds is accepted as declared', () => {
  assert.deepEqual(verifyDeclaredUsage(input, result(3, 2)), {
    inputTokens: 3,
    outputTokens: 2,
  });
});

void test('input above the conversation bytes plus the template allowance is refused', () => {
  const ceiling = 'hola'.length + FREE_METERING.declaredTemplateTokens;
  assert.ok(verifyDeclaredUsage(input, result(ceiling, 2)));
  refused(() => verifyDeclaredUsage(input, result(ceiling + 1, 2)));
  refused(() => verifyDeclaredUsage(input, result(0, 2)));
});

void test('output above the delivered bytes plus one allowance, or past maxTokens, is refused', () => {
  const ceiling = 'respuesta'.length + FREE_METERING.declaredTemplateTokens;
  assert.ok(verifyDeclaredUsage(input, result(3, ceiling)));
  refused(() => verifyDeclaredUsage(input, result(3, ceiling + 1)));
  const long = 'x'.repeat(2000);
  refused(() => verifyDeclaredUsage(input, result(3, 501, long)));
});

void test('output below the delivered text floor is refused', () => {
  const text = 'y'.repeat(FREE_METERING.declaredMaxTokenBytes * 3);
  assert.ok(verifyDeclaredUsage(input, result(3, 3, text)));
  refused(() => verifyDeclaredUsage(input, result(3, 2, text)));
});

void test('non-integer or negative counts are refused', () => {
  refused(() => verifyDeclaredUsage(input, result(3.5, 2)));
  refused(() => verifyDeclaredUsage(input, result(3, -1)));
});
