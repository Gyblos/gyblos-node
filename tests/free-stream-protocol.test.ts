// Pins streaming framing independently from execution, using only synthetic signed quotes.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';

import { freeSellerFixture } from './support/free-seller.js';

async function messages() {
  const source = await freeSellerFixture();
  const request = await source.request();
  const header = {
    version: 2,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
  };
  const delta = { ...header, sequence: 0, type: 'delta', text: 'answer' };
  const terminal = {
    ...header,
    sequence: 1,
    type: 'terminal',
    response: {
      ...header,
      result: {
        text: 'answer',
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
    },
  };
  return { request, delta, terminal };
}
void test('free stream validates correlated deltas and an exact terminal response', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const stream = await api.createFreeStreamVerifier(fixture.request);
  assert.deepEqual(await stream.accept(fixture.delta), { delta: 'answer' });
  const final = await stream.accept(fixture.terminal);
  assert.equal(final.result?.text, 'answer');
  stream.finish();
  await assert.rejects(stream.accept(fixture.terminal), {
    code: FREE_EXECUTION_CODES.INVALID,
  });
});
void test('free stream rejects sequence and binding mismatches before delivering text', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  for (const changed of [
    { ...fixture.delta, sequence: 1 },
    { ...fixture.delta, requestId: '00'.repeat(16) },
    { ...fixture.delta, requestDigest: '00'.repeat(32) },
  ]) {
    const stream = await api.createFreeStreamVerifier(fixture.request);
    await assert.rejects(stream.accept(changed));
  }
});
void test('free stream rejects missing terminal and terminal text that differs from deltas', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const stream = await api.createFreeStreamVerifier(fixture.request);
  await stream.accept(fixture.delta);
  assert.throws(() => stream.finish(), { code: FREE_EXECUTION_CODES.INVALID });
  const mismatch = await api.createFreeStreamVerifier(fixture.request);
  await assert.rejects(mismatch.accept({ ...fixture.terminal, sequence: 0 }), {
    code: FREE_EXECUTION_CODES.BINDING,
  });
});
void test('free stream frames bound sizes, canonical JSON and Unicode-safe delta chunks', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const encoded = api.encodeFreeStreamEvent(fixture.delta);
  assert.deepEqual(api.decodeFreeStreamEvent(encoded), fixture.delta);
  assert.throws(() =>
    api.decodeFreeStreamEvent(encoded.subarray(0, encoded.length - 1)),
  );
  assert.throws(
    () =>
      api.encodeFreeStreamEvent({ ...fixture.delta, text: 'a'.repeat(8193) }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
  const text = '😀'.repeat(4097);
  const chunks = [...api.freeStreamDeltas(text)];
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8192));
});
