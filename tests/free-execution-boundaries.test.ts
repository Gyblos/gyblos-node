// Covers protocol boundary guards and caller conveniences with immutable synthetic vectors; no transport.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';

async function fixture() {
  const api = await import('@gyblos/protocol/free-execution');
  const vector: { request: unknown; response: unknown; error: unknown } =
    JSON.parse(
      await readFile(
        new URL(
          import.meta
            .resolve('@gyblos/protocol/vectors/free-execution-v4.json'),
        ),
        'utf8',
      ),
    );
  const request = api.parseFreeExecutionRequest(vector.request);
  return { api, vector, request };
}
void test('free execution bounds aggregate message bytes independently of each message', async () => {
  const { api, request } = await fixture();
  const content = 'x'.repeat(FREE_EXECUTION.inputBytes / 2);
  const messages = [
    { role: FREE_CHAT_ROLES.USER, content },
    { role: FREE_CHAT_ROLES.ASSISTANT, content },
  ];
  assert.doesNotThrow(() =>
    api.parseFreeExecutionRequest({
      ...request,
      input: { ...request.input, messages },
    }),
  );
  messages[1]!.content += 'x';
  assert.throws(
    () =>
      api.parseFreeExecutionRequest({
        ...request,
        input: { ...request.input, messages },
      }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
void test('free execution rejects combined usage beyond context even when each count and output maximum fit', async () => {
  const { api, request } = await fixture();
  const response = {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await api.freeExecutionDigest(request),
    result: {
      text: 'x',
      usage: {
        inputTokens: request.quote.offer.model.contextTokens,
        outputTokens: 1,
      },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
  };
  await assert.rejects(api.matchFreeExecutionResponse(response, request), {
    code: FREE_EXECUTION_CODES.LIMIT,
  });
});
void test('free execution request parser bounds JSON escaping before a transport encoder runs', async () => {
  const { api, request } = await fixture();
  const content = '\0'.repeat(Math.floor(FREE_EXECUTION.requestBytes / 6));
  assert.ok(Buffer.byteLength(content) < FREE_EXECUTION.inputBytes);
  assert.throws(
    () =>
      api.parseFreeExecutionRequest({
        ...request,
        input: {
          ...request.input,
          messages: [{ role: FREE_CHAT_ROLES.USER, content }],
        },
      }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
void test('free execution response parser bounds JSON escaping independently of raw text size', async () => {
  const { api, request } = await fixture();
  const text = '\0'.repeat(FREE_EXECUTION.outputBytes);
  assert.equal(Buffer.byteLength(text), FREE_EXECUTION.outputBytes);
  assert.throws(
    () =>
      api.parseFreeExecutionResponse({
        version: FREE_EXECUTION.version,
        requestId: request.requestId,
        requestDigest: '0'.repeat(64),
        result: {
          text,
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: ENGINE_DONE_REASONS.STOP,
        },
      }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
void test('free execution maps configured seller owner and NodeId mismatches to binding errors', async () => {
  const { api, request } = await fixture();
  const offer = request.quote.offer;
  const trust = {
    owner: offer.owner,
    nodeId: offer.nodeId,
    remoteNodeId: offer.buyerNodeId,
    now: offer.issuedAt,
  };
  assert.notEqual(offer.buyer, offer.owner);
  for (const changed of [
    { ...trust, owner: offer.buyer },
    { ...trust, nodeId: 'f'.repeat(64) },
  ])
    await assert.rejects(api.verifyFreeExecutionRequest(request, changed), {
      code: FREE_EXECUTION_CODES.BINDING,
    });
});
void test('free execution distinguishes matched remote errors from local validation failures', async () => {
  const { api, vector, request } = await fixture();
  await assert.rejects(api.matchFreeExecutionResponse(vector.error, request), {
    code: FREE_EXECUTION_CODES.BUSY,
    remote: true,
  });
  const response = api.parseFreeExecutionResponse(vector.error);
  await assert.rejects(
    api.matchFreeExecutionResponse(
      { ...response, requestDigest: 'f'.repeat(64) },
      request,
    ),
    { code: FREE_EXECUTION_CODES.BINDING, remote: false },
  );
  assert.throws(
    () => api.parseFreeExecutionRequest({ ...request, version: 99 }),
    { code: FREE_EXECUTION_CODES.VERSION, remote: false },
  );
});
void test('free execution builder takes selection and reasoning from the signed quote and detaches input', async () => {
  const { api, request } = await fixture();
  const input = {
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'new input' }],
    maxTokens: 2,
  };
  const built = api.buildFreeExecutionRequest(request.quote, input);
  assert.deepEqual(built, {
    ...request,
    input: {
      ...input,
      selection: request.quote.offer.selection,
      reasoning: request.quote.offer.reasoning,
    },
  });
  input.messages[0]!.content = 'changed';
  assert.equal(built.input.messages[0]!.content, 'new input');
  const unsupported = { ...input, stream: true };
  assert.throws(
    () => api.buildFreeExecutionRequest(request.quote, unsupported),
    { code: FREE_EXECUTION_CODES.INVALID },
  );
  assert.throws(
    () =>
      api.buildFreeExecutionRequest(request.quote, {
        ...input,
        maxTokens: request.quote.offer.maxTokens + 1,
      }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
