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

function validEnvelope() {
  const tokenize = (token: string) => ({
    token,
    logprob: -0.1,
    bytes: Array.from(new TextEncoder().encode(token)),
  });
  const topLogprobs = Array.from(
    { length: CHALLENGE_SET.rule.topLogprobs },
    (_, index) => tokenize(` token${index}`),
  );
  const entry = { ...tokenize(' token0'), top_logprobs: topLogprobs };
  return {
    response: ' token0',
    done: true,
    done_reason: 'stop',
    logprobs: [entry],
  };
}

function tagsResponse() {
  return Response.json({ models: [{ name: 'qwen3:1.7b', digest: DIGEST }] });
}

void test('oversized reference responses are cancelled before decoding', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const writtenAtCancel: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags')) return tagsResponse();
    let written = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (written < 32) {
          written++;
          controller.enqueue(chunk);
        } else controller.close();
      },
      cancel() {
        writtenAtCancel.push(written);
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
  assert.equal(writtenAtCancel.length, MODEL_VERIFIER.referenceAttempts);
  for (const count of writtenAtCancel) assert.ok(count < 32, String(count));
});

void test('malformed reference response envelopes are rejected at the boundary', async () => {
  const valid = validEnvelope();
  const entry = valid.logprobs[0]!;
  const topLogprobs = entry.top_logprobs;
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
      if (String(input).endsWith('/api/tags')) return tagsResponse();
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

void test('a full valid reference envelope is accepted', async () => {
  const json = JSON.stringify(validEnvelope());
  const bodies = [json, '\uFEFF' + json];
  for (const body of bodies) {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/api/tags') ? tagsResponse() : new Response(body);
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    const candidates = await reference.candidates(
      'prompt',
      CHALLENGE_SET.rule.topLogprobs,
    );
    assert.equal(candidates?.length, CHALLENGE_SET.rule.topLogprobs);
    assert.equal(candidates?.[0]?.token, ' token0');
    assert.equal(candidates?.[0]?.logprob, -0.1);
  }
});

void test('reference responses with invalid UTF-8 bytes fail closed', async () => {
  const json = JSON.stringify(validEnvelope());
  const bytes = new TextEncoder().encode(json);
  bytes[json.indexOf('token0')] = 0xff;
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags')) return tagsResponse();
    calls++;
    return new Response(bytes, {
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
  assert.equal(calls, MODEL_VERIFIER.referenceAttempts);
});

void test('responses at the byte cap are read and larger ones rejected', async () => {
  const json = JSON.stringify(validEnvelope());
  const pad = (total: number) => json + ' '.repeat(total - json.length);
  const bodies = [
    [pad(MODEL_VERIFIER.referenceMaxResponseBytes), true],
    [pad(MODEL_VERIFIER.referenceMaxResponseBytes + 1), false],
  ] as const;
  for (const [body, accepted] of bodies) {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/api/tags') ? tagsResponse() : new Response(body);
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    const pending = reference.candidates(
      'prompt',
      CHALLENGE_SET.rule.topLogprobs,
    );
    if (accepted) {
      const candidates = await pending;
      assert.equal(candidates?.length, CHALLENGE_SET.rule.topLogprobs);
    } else {
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof ModelVerifierError &&
          error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
      );
    }
  }
});
