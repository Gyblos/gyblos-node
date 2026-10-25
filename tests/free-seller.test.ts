// Exercises free seller policy with ephemeral quotes and a synthetic engine; no payment services exist.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { FREE_CHAT_ROLES, FREE_EXECUTION, FREE_EXECUTION_CODES, ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { EngineResult } from '@gyblos/protocol/engine';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { signOfferV2 } from '@gyblos/protocol/offer-v2';
import { OFFER_PRICING_KINDS } from '@gyblos/node/constants';
import { controlFixture } from './support/control-fixture.js';

async function fixture(caps = { dailyTokenCap: 100, perBuyerCap: 50 }) {
  const api = await import('@gyblos/node/free-execution');
  const source = await controlFixture(true);
  let calls = 0;
  let now = source.context.now();
  let busy = false;
  let run = async (): Promise<EngineResult> => ({ text: 'answer', usage: { inputTokens: 4, outputTokens: 2, totalDurationNs: 0, loadDurationNs: 0, inputDurationNs: 0, outputDurationNs: 0 }, finishReason: ENGINE_DONE_REASONS.STOP });
  const model = source.context.models[0]!;
  const service = api.createSellerFreeExecution({
    owner: source.context.owner, nodeId: source.context.nodeId,
    offer: { kind: OFFER_PRICING_KINDS.FREE, modelId: 'qwen3-0.6b', reasoning: model.reasoning, caps },
    selection: model.selection, model: model.model, capabilities: model.capabilities,
    engine: { describe: async () => { throw new Error('unexpected describe'); }, capabilities: () => { throw new Error('unexpected capabilities'); }, generate: async () => { calls++; return run(); } },
    tokenizer: { input: () => 4, count: () => 2 },
    readiness: () => ({ ...source.context.readiness(), busy }), now: () => now, startedAt: now - 1,
  });
  async function request(sequence = 1, peer = source.request.params.buyerNodeId) {
    const query = { ...source.request, requestId: sequence.toString(16).padStart(32, '0'), params: { ...source.request.params, buyerNodeId: peer, maxTokens: 10 } };
    const quote = await createControlQuote(query, { ...source.context, remoteNodeId: peer }, source.ownerSigner);
    return { version: FREE_EXECUTION.version, requestId: quote.offer.requestId, quote, input: { messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }], selection: quote.offer.selection, reasoning: quote.offer.reasoning, maxTokens: 10 } };
  }
  return { service, source, request, calls: () => calls, setNow: (value: number) => { now = value; }, setBusy: (value: boolean) => { busy = value; }, setRun: (value: typeof run) => { run = value; } };
}
const signal = () => new AbortController().signal;

void test('free seller executes one authenticated request and returns bounded recounted usage', async () => {
  const state = await fixture();
  const request = await state.request();
  const result = await state.service.respond(request, request.quote.offer.buyerNodeId, signal());
  assert.deepEqual(result, { version: FREE_EXECUTION.version, requestId: request.requestId, requestDigest: await freeExecutionDigest(request), result: { text: 'answer', usage: { inputTokens: 4, outputTokens: 2 }, finishReason: ENGINE_DONE_REASONS.STOP } });
  assert.equal(state.calls(), 1);
});
void test('free seller rejects wrong peer, signature, expiry and paid quotes before generation', async () => {
  const state = await fixture();
  const request = await state.request();
  assert.equal((await state.service.respond(request, 'f'.repeat(64), signal())).error?.code, FREE_EXECUTION_CODES.PEER);
  const forged = { ...request, quote: { ...request.quote, signature: Buffer.alloc(64).toString('base64') } };
  assert.equal((await state.service.respond(forged, request.quote.offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.SIGNATURE);
  state.setNow(request.quote.offer.expiresAt);
  assert.equal((await state.service.respond(request, request.quote.offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.EXPIRED);
  assert.equal(state.calls(), 0);
});
void test('free seller rejects replay after success and after engine failure without fallback', async () => {
  const state = await fixture();
  const request = await state.request();
  const peer = request.quote.offer.buyerNodeId;
  await state.service.respond(request, peer, signal());
  assert.equal((await state.service.respond(request, peer, signal())).error?.code, FREE_EXECUTION_CODES.REPLAY);
  state.setRun(async () => { throw new Error('private engine details'); });
  const second = await state.request(2);
  assert.equal((await state.service.respond(second, peer, signal())).error?.code, FREE_EXECUTION_CODES.ENGINE);
  assert.equal((await state.service.respond(second, peer, signal())).error?.code, FREE_EXECUTION_CODES.REPLAY);
  assert.equal(state.calls(), 2);
});
void test('free seller enforces total cap before per-buyer cap and shares it across NodeIds', async () => {
  const state = await fixture({ dailyTokenCap: 14, perBuyerCap: 14 });
  const first = await state.request();
  await state.service.respond(first, first.quote.offer.buyerNodeId, signal());
  const second = await state.request(2, 'f'.repeat(64));
  assert.equal((await state.service.respond(second, second.quote.offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.DAILY_CAP);
  assert.equal(state.calls(), 1);
});
void test('free seller enforces per-buyer cap while another buyer can use remaining total', async () => {
  const state = await fixture({ dailyTokenCap: 100, perBuyerCap: 14 });
  const first = await state.request();
  await state.service.respond(first, first.quote.offer.buyerNodeId, signal());
  const second = await state.request(2);
  assert.equal((await state.service.respond(second, second.quote.offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.BUYER_CAP);
  const other = await state.request(3, 'f'.repeat(64));
  assert.ok((await state.service.respond(other, other.quote.offer.buyerNodeId, signal())).result);
  assert.equal(state.calls(), 2);
});
void test('free seller refuses busy and unsupported chat without an engine call', async () => {
  const state = await fixture();
  const request = await state.request();
  const peer = request.quote.offer.buyerNodeId;
  state.setBusy(true);
  assert.equal((await state.service.respond(request, peer, signal())).error?.code, FREE_EXECUTION_CODES.BUSY);
  state.setBusy(false);
  const unsupported = { ...request, input: { ...request.input, messages: [{ role: FREE_CHAT_ROLES.SYSTEM, content: 'x' }] } };
  assert.equal((await state.service.respond(unsupported, peer, signal())).error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(state.calls(), 0);
});
void test('free seller holds active capacity until an uncooperative engine settles after cancellation', async () => {
  const state = await fixture();
  let settle: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  state.setRun(async () => { entered!(); await new Promise<void>((resolve) => { settle = resolve; }); throw new Error('stopped'); });
  const first = await state.request();
  const controller = new AbortController();
  const running = state.service.respond(first, first.quote.offer.buyerNodeId, controller.signal);
  await started;
  controller.abort();
  const next = await state.request(2, 'f'.repeat(64));
  assert.equal((await state.service.respond(next, next.quote.offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.BUSY);
  settle!();
  assert.equal((await running).error?.code, FREE_EXECUTION_CODES.CANCELLED);
});
void test('free seller refuses quotes issued before its startup barrier', async () => {
  const state = await fixture();
  const request = await state.request();
  const offer = { ...request.quote.offer, issuedAt: request.quote.offer.issuedAt - 2, availability: { ...request.quote.offer.availability, observedAt: request.quote.offer.issuedAt - 2 } };
  const quote = await signOfferV2(offer, state.source.ownerSigner);
  assert.equal((await state.service.respond({ ...request, quote }, offer.buyerNodeId, signal())).error?.code, FREE_EXECUTION_CODES.EXPIRED);
  assert.equal(state.calls(), 0);
});
