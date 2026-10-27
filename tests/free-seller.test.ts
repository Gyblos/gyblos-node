// Exercises free seller policy with ephemeral quotes and a synthetic engine; no payment services exist.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { signOfferV2 } from '@gyblos/protocol/offer-v2';

import {
  freeSellerFixture as fixture,
  freeSellerSignal as signal,
} from './support/free-seller';

void test('free seller executes one authenticated request and returns bounded recounted usage', async () => {
  const state = await fixture();
  const request = await state.request();
  const result = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.deepEqual(result, {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    result: {
      text: 'answer',
      usage: { inputTokens: 4, outputTokens: 2 },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
  });
  assert.equal(state.calls(), 1);
});
void test('free seller rejects wrong peer, signature, expiry and paid quotes before generation', async () => {
  const state = await fixture();
  const request = await state.request();
  assert.equal(
    (await state.service.respond(request, 'f'.repeat(64), signal())).error
      ?.code,
    FREE_EXECUTION_CODES.PEER,
  );
  const forged = {
    ...request,
    quote: { ...request.quote, signature: Buffer.alloc(64).toString('base64') },
  };
  assert.equal(
    (
      await state.service.respond(
        forged,
        request.quote.offer.buyerNodeId,
        signal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.SIGNATURE,
  );
  await assert.rejects(
    state.service.respond(
      {
        ...request,
        quote: {
          ...request.quote,
          offer: {
            ...request.quote.offer,
            prices: { inputAtomicPerMtok: '1', outputAtomicPerMtok: '0' },
          },
        },
      },
      request.quote.offer.buyerNodeId,
      signal(),
    ),
    { code: FREE_EXECUTION_CODES.NOT_FREE },
  );
  await assert.rejects(
    state.service.respond(
      {
        ...request,
        input: {
          ...request.input,
          maxTokens: request.quote.offer.maxTokens + 1,
        },
      },
      request.quote.offer.buyerNodeId,
      signal(),
    ),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
  state.setNow(request.quote.offer.expiresAt);
  assert.equal(
    (
      await state.service.respond(
        request,
        request.quote.offer.buyerNodeId,
        signal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.EXPIRED,
  );
  assert.equal(state.calls(), 0);
});
void test('free seller rejects replay after success and after engine failure without fallback', async () => {
  const state = await fixture();
  const request = await state.request();
  const peer = request.quote.offer.buyerNodeId;
  await state.service.respond(request, peer, signal());
  assert.equal(
    (await state.service.respond(request, peer, signal())).error?.code,
    FREE_EXECUTION_CODES.REPLAY,
  );
  state.setRun(async () => {
    throw new Error('private engine details');
  });
  const second = await state.request(2);
  assert.equal(
    (await state.service.respond(second, peer, signal())).error?.code,
    FREE_EXECUTION_CODES.ENGINE,
  );
  assert.equal(
    (await state.service.respond(second, peer, signal())).error?.code,
    FREE_EXECUTION_CODES.REPLAY,
  );
  assert.equal(state.calls(), 2);
});
void test('free seller enforces total cap before per-buyer cap and shares it across NodeIds', async () => {
  const state = await fixture({ dailyTokenCap: 14, perBuyerCap: 14 });
  const first = await state.request();
  await state.service.respond(first, first.quote.offer.buyerNodeId, signal());
  const second = await state.request(2, 'f'.repeat(64));
  assert.equal(
    (
      await state.service.respond(
        second,
        second.quote.offer.buyerNodeId,
        signal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
  assert.equal(state.calls(), 1);
});
void test('free seller enforces per-buyer cap while another buyer can use remaining total', async () => {
  const state = await fixture({ dailyTokenCap: 100, perBuyerCap: 14 });
  const first = await state.request();
  await state.service.respond(first, first.quote.offer.buyerNodeId, signal());
  const second = await state.request(2);
  assert.equal(
    (
      await state.service.respond(
        second,
        second.quote.offer.buyerNodeId,
        signal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.BUYER_CAP,
  );
  const other = await state.request(3, 'f'.repeat(64));
  assert.ok(
    (
      await state.service.respond(
        other,
        other.quote.offer.buyerNodeId,
        signal(),
      )
    ).result,
  );
  assert.equal(state.calls(), 2);
});
void test('free seller refuses busy and unsupported chat without an engine call', async () => {
  const state = await fixture();
  const request = await state.request();
  const peer = request.quote.offer.buyerNodeId;
  state.setBusy(true);
  assert.equal(
    (await state.service.respond(request, peer, signal())).error?.code,
    FREE_EXECUTION_CODES.BUSY,
  );
  state.setBusy(false);
  const unsupported = {
    ...request,
    input: {
      ...request.input,
      messages: [{ role: FREE_CHAT_ROLES.SYSTEM, content: 'x' }],
    },
  };
  assert.equal(
    (await state.service.respond(unsupported, peer, signal())).error?.code,
    FREE_EXECUTION_CODES.UNSUPPORTED,
  );
  assert.equal(state.calls(), 0);
});
void test('free seller holds active capacity until an uncooperative engine settles after cancellation', async () => {
  const state = await fixture();
  let settle: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state.setRun(async () => {
    entered!();
    await new Promise<void>((resolve) => {
      settle = resolve;
    });
    throw new Error('stopped');
  });
  const first = await state.request();
  const controller = new AbortController();
  const running = state.service.respond(
    first,
    first.quote.offer.buyerNodeId,
    controller.signal,
  );
  await started;
  controller.abort();
  const next = await state.request(2, 'f'.repeat(64));
  assert.equal(
    (await state.service.respond(next, next.quote.offer.buyerNodeId, signal()))
      .error?.code,
    FREE_EXECUTION_CODES.BUSY,
  );
  settle!();
  assert.equal((await running).error?.code, FREE_EXECUTION_CODES.CANCELLED);
});
void test('free seller refuses quotes issued before its startup barrier', async () => {
  const state = await fixture();
  const request = await state.request();
  const offer = {
    ...request.quote.offer,
    issuedAt: request.quote.offer.issuedAt - 2,
    availability: {
      ...request.quote.offer.availability,
      observedAt: request.quote.offer.issuedAt - 2,
    },
  };
  const quote = await signOfferV2(offer, state.source.ownerSigner);
  assert.equal(
    (
      await state.service.respond(
        { ...request, quote },
        offer.buyerNodeId,
        signal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.EXPIRED,
  );
  assert.equal(state.calls(), 0);
});

void test('free seller refuses stale or future readiness before generation', async () => {
  for (const stale of ['future', 'expired']) {
    const state = await fixture();
    const request = await state.request();
    const now = state.source.context.now();
    state.source.setReadiness(
      stale === 'future' ? { observedAt: now + 1 } : { validUntil: now },
    );
    const response = await state.service.respond(
      request,
      request.quote.offer.buyerNodeId,
      signal(),
    );
    assert.equal(response.error?.code, FREE_EXECUTION_CODES.ENGINE);
    assert.equal(state.calls(), 0);
  }
});
void test('free seller requires exact configured selection, model and capabilities before generation', async () => {
  for (const mismatch of ['selection', 'model', 'capabilities']) {
    const state = await fixture();
    const request = await state.request();
    const configured = state.source.context.models[0]!;
    if (mismatch === 'selection') configured.selection.variant = 'other';
    if (mismatch === 'model') configured.model.name = 'other';
    if (mismatch === 'capabilities') configured.capabilities.logprobs = true;
    const response = await state.service.respond(
      request,
      request.quote.offer.buyerNodeId,
      signal(),
    );
    assert.equal(response.error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
    assert.equal(state.calls(), 0);
  }
});
void test('free seller refuses recounted input plus requested output beyond context before generation', async () => {
  const state = await fixture({ dailyTokenCap: 10000, perBuyerCap: 10000 });
  const request = await state.request();
  state.setCounts(
    request.quote.offer.model.contextTokens - request.input.maxTokens + 1,
    2,
  );
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.LIMIT);
  assert.equal(state.calls(), 0);
});
void test('free seller refuses recounted output beyond the requested maximum after one generation', async () => {
  const state = await fixture();
  const request = await state.request();
  state.setCounts(4, request.input.maxTokens + 1);
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.LIMIT);
  assert.equal(response.result, undefined);
  assert.equal(state.calls(), 1);
});
