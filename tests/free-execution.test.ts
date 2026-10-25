// Exercises detached free-execution contracts with synthetic quotes; never invokes an engine or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { FREE_EXECUTION, FREE_EXECUTION_CODES, FREE_CHAT_ROLES, ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { signOfferV2 } from '@gyblos/protocol/offer-v2';

import { controlFixture } from './support/control-fixture.js';

async function fixture() {
  const source = await controlFixture(true);
  const quote = await createControlQuote(source.request, source.context, source.ownerSigner);
  const request = {
    version: FREE_EXECUTION.version,
    requestId: quote.offer.requestId,
    quote,
    input: {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello\nworld 🌍' }],
      selection: quote.offer.selection,
      reasoning: quote.offer.reasoning,
      maxTokens: quote.offer.maxTokens,
    },
  };
  const trust = { owner: quote.offer.owner, nodeId: quote.offer.nodeId, remoteNodeId: quote.offer.buyerNodeId, now: quote.offer.issuedAt };
  return { source, request, trust };
}

void test('free execution authenticates a free quote and preserves multiline chat input', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request, trust } = await fixture();
  assert.deepEqual(await api.verifyFreeExecutionRequest(request, trust), request);
  assert.equal(FREE_EXECUTION.alpn, 'gyblos/free/2');
});

void test('free execution refuses either paid price component and a nonzero budget', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  for (const offer of [
    { ...request.quote.offer, prices: { inputAtomicPerMtok: '1', outputAtomicPerMtok: '0' } },
    { ...request.quote.offer, prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '1' } },
    { ...request.quote.offer, maxAtomic: '1' },
  ]) assert.throws(() => api.parseFreeExecutionRequest({ ...request, quote: { ...request.quote, offer } }), { code: FREE_EXECUTION_CODES.NOT_FREE });
});

void test('free execution binds requestId, exact selection, reasoning and output ceiling', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  assert.throws(() => api.parseFreeExecutionRequest({ ...request, requestId: 'f'.repeat(32) }), { code: FREE_EXECUTION_CODES.BINDING });
  for (const input of [
    { ...request.input, selection: { ...request.input.selection, variant: 'other' } },
    { ...request.input, reasoning: 'low' },
  ]) assert.throws(() => api.parseFreeExecutionRequest({ ...request, input }), { code: FREE_EXECUTION_CODES.BINDING });
  assert.throws(() => api.parseFreeExecutionRequest({ ...request, input: { ...request.input, maxTokens: request.input.maxTokens + 1 } }), { code: FREE_EXECUTION_CODES.LIMIT });
});

void test('free execution verifies signature, peer and zero-skew expiry boundaries', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request, trust } = await fixture();
  await assert.rejects(api.verifyFreeExecutionRequest(request, { ...trust, remoteNodeId: 'f'.repeat(64) }), { code: FREE_EXECUTION_CODES.PEER });
  await assert.rejects(api.verifyFreeExecutionRequest(request, { ...trust, now: request.quote.offer.expiresAt }), { code: FREE_EXECUTION_CODES.EXPIRED });
  await assert.rejects(api.verifyFreeExecutionRequest(request, { ...trust, now: request.quote.offer.issuedAt - 1 }), { code: FREE_EXECUTION_CODES.EXPIRED });
  await assert.rejects(api.verifyFreeExecutionRequest({ ...request, quote: { ...request.quote, signature: Buffer.alloc(64).toString('base64') } }, trust), { code: FREE_EXECUTION_CODES.SIGNATURE });
  assert.deepEqual(await api.verifyFreeExecutionRequest(request, { ...trust, now: request.quote.offer.expiresAt - 1 }), request);
});

void test('free execution rejects unknown fields, getters and unsupported chat roles', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  for (const value of [
    { ...request, payment: {} },
    { ...request, input: { ...request.input, stream: true } },
    { ...request, input: { ...request.input, messages: [{ role: 'tool', content: 'x' }] } },
    { ...request, input: { ...request.input, messages: [] } },
  ]) assert.throws(() => api.parseFreeExecutionRequest(value), { code: FREE_EXECUTION_CODES.INVALID });
  let invoked = false;
  const value = { ...request };
  Object.defineProperty(value, 'input', { enumerable: true, get() { invoked = true; return request.input; } });
  assert.throws(() => api.parseFreeExecutionRequest(value), { code: FREE_EXECUTION_CODES.INVALID });
  assert.equal(invoked, false);
});

void test('free execution bounds UTF-8 input and rejects unpaired surrogates', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  for (const content of ['🌍'.repeat(FREE_EXECUTION.inputBytes), '\ud800'])
    assert.throws(() => api.parseFreeExecutionRequest({ ...request, input: { ...request.input, messages: [{ role: FREE_CHAT_ROLES.USER, content }] } }));
  assert.throws(() => api.parseFreeExecutionRequest({ ...request, input: { ...request.input, messages: Array.from({ length: FREE_EXECUTION.maxMessages + 1 }, () => ({ role: FREE_CHAT_ROLES.USER, content: 'x' })) } }));
});

void test('free execution digest binds the prompt and limits, independently of the quote digest', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  const digest = await api.freeExecutionDigest(request);
  assert.notEqual(digest, request.quote.offer.requestDigest);
  assert.notEqual(await api.freeExecutionDigest({ ...request, input: { ...request.input, maxTokens: 1 } }), digest);
  assert.notEqual(await api.freeExecutionDigest({ ...request, input: { ...request.input, messages: [{ role: FREE_CHAT_ROLES.USER, content: 'different' }] } }), digest);
});

void test('free execution response correlation and usage are bound to the execution request', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  const response = {
    version: FREE_EXECUTION.version, requestId: request.requestId,
    requestDigest: await api.freeExecutionDigest(request),
    result: { text: 'Hello', usage: { inputTokens: 4, outputTokens: 1 }, finishReason: ENGINE_DONE_REASONS.STOP },
  };
  assert.deepEqual(await api.matchFreeExecutionResponse(response, request), response.result);
  await assert.rejects(api.matchFreeExecutionResponse({ ...response, requestDigest: 'f'.repeat(64) }, request), { code: FREE_EXECUTION_CODES.BINDING });
  await assert.rejects(api.matchFreeExecutionResponse({ ...response, result: { ...response.result, usage: { inputTokens: 1, outputTokens: request.input.maxTokens + 1 } } }, request), { code: FREE_EXECUTION_CODES.LIMIT });
  assert.throws(() => api.parseFreeExecutionResponse({ ...response, result: { ...response.result, finishReason: 'unknown' } }));
  assert.throws(() => api.parseFreeExecutionResponse({ ...response, result: { ...response.result, usage: { inputTokens: -1, outputTokens: 0 } } }));
});

void test('free execution errors are static, exclusive and correlated before propagation', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request } = await fixture();
  const response = { version: FREE_EXECUTION.version, requestId: request.requestId, requestDigest: await api.freeExecutionDigest(request), error: { code: FREE_EXECUTION_CODES.BUSY } };
  await assert.rejects(api.matchFreeExecutionResponse(response, request), { code: FREE_EXECUTION_CODES.BUSY });
  await assert.rejects(api.matchFreeExecutionResponse({ ...response, requestId: 'f'.repeat(32) }, request), { code: FREE_EXECUTION_CODES.BINDING });
  assert.throws(() => api.parseFreeExecutionResponse({ ...response, error: { code: 'arbitrary secret' } }));
  assert.throws(() => api.parseFreeExecutionResponse({ ...response, error: { code: FREE_EXECUTION_CODES.INTERNAL, message: 'secret' } }));
  assert.throws(() => api.parseFreeExecutionResponse({ ...response, result: {} }));
});

void test('free execution parsers detach values and do not claim to consume replay state', async () => {
  const api = await import('@gyblos/protocol/free-execution');
  const { request, source, trust } = await fixture();
  const parsed = api.parseFreeExecutionRequest(request);
  request.input.messages[0]!.content = 'mutated';
  assert.notEqual(parsed.input.messages[0]!.content, 'mutated');
  const again = { ...parsed, quote: await signOfferV2(parsed.quote.offer, source.ownerSigner) };
  assert.deepEqual(await api.verifyFreeExecutionRequest(again, trust), parsed);
  assert.deepEqual(await api.verifyFreeExecutionRequest(again, trust), parsed);
});
