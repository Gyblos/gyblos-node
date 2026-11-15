// A paid answer is asked for at most the seller's quoted bound and the paid limit; free bounds stay intact.
import assert from 'node:assert/strict';
import test from 'node:test';

import { paidAnswerInput } from '@gyblos/buyer/paid-startup';
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';

const paidLimit = INFERENCE_REQUEST_LIMITS.maxOutputTokens;

void test('a long free request is served up to the paid bound on a paid seller', () => {
  const input = { messages: [], maxTokens: 4096 };
  assert.deepEqual(paidAnswerInput(input, paidLimit), {
    messages: [],
    maxTokens: paidLimit,
  });
  assert.equal(input.maxTokens, 4096);
});

void test('the quoted bound wins when it is smaller, and a short request is unchanged', () => {
  assert.equal(paidAnswerInput({ maxTokens: 4096 }, 64).maxTokens, 64);
  const short = { maxTokens: 50 };
  assert.equal(paidAnswerInput(short, paidLimit), short);
});

void test('a quote above the paid limit cannot raise the paid bound', () => {
  assert.equal(
    paidAnswerInput({ maxTokens: 4096 }, paidLimit * 4).maxTokens,
    paidLimit,
  );
});
