import assert from 'node:assert/strict';
import test from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { openReference } from '@gyblos/model-verifier/reference';

const DIGEST = 'cd'.repeat(32);

void test('oversized reference responses are cancelled before decoding', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let cancellations = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
      });
    let written = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (written < 32) {
          written++;
          controller.enqueue(chunk);
        } else controller.close();
      },
      cancel() {
        cancellations++;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const reference = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    fetchImpl,
    0,
  );
  await assert.rejects(
    reference.candidates('prompt', CHALLENGE_SET.rule.topLogprobs),
    (error: unknown) =>
      error instanceof ModelVerifierError &&
      error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
  );
  assert.equal(cancellations, MODEL_VERIFIER.referenceAttempts);
});

void test('malformed reference response envelopes are rejected at the boundary', async () => {
  const topLogprobs = Array.from(
    { length: CHALLENGE_SET.rule.topLogprobs },
    (_, index) => ({
      token: ` token${index}`,
      logprob: -0.1,
      bytes: [32, 116],
    }),
  );
  const entry = {
    token: ' token0',
    logprob: -0.1,
    bytes: [32, 116],
    top_logprobs: topLogprobs,
  };
  const valid = {
    response: ' token0',
    done: true,
    done_reason: 'stop',
    logprobs: [entry],
  };
  const cases = [
    ['not done', { ...valid, done: false }],
    ['missing response', { ...valid, response: undefined }],
    ['multiple entries', { ...valid, logprobs: [entry, entry] }],
    [
      'invalid selected token',
      { ...valid, logprobs: [{ ...entry, token: 1 }] },
    ],
    [
      'invalid selected logprob',
      { ...valid, logprobs: [{ ...entry, logprob: 0.1 }] },
    ],
    [
      'invalid selected bytes',
      { ...valid, logprobs: [{ ...entry, bytes: [256] }] },
    ],
    [
      'invalid candidate bytes',
      {
        ...valid,
        logprobs: [
          {
            ...entry,
            top_logprobs: topLogprobs.map((candidate, index) =>
              index === 0 ? { ...candidate, bytes: [-1] } : candidate,
            ),
          },
        ],
      },
    ],
  ] as const;
  for (const [name, body] of cases) {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
        });
      calls++;
      return Response.json(body);
    };
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    await assert.rejects(
      reference.candidates('prompt', CHALLENGE_SET.rule.topLogprobs),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
      name,
    );
    assert.equal(calls, MODEL_VERIFIER.referenceAttempts, name);
  }
});
