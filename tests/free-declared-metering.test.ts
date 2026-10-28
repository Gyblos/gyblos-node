// A free offer whose provider declares usage: the buyer receives the provider's counts within the same
// bounds it verifies, an implausible count is the provider's invalid response, admission reserves a
// byte bound that is never refunded, and a stream is bounded by bytes per token. Synthetic engines; no
// tokenizer, files or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_METERING } from '@gyblos/node/constants';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import { EngineError, type EngineResult } from '@gyblos/protocol/engine';
import { matchFreeExecutionResponse } from '@gyblos/protocol/free-execution';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';
import { freeStreamSellerFixture } from './support/free-stream-seller';

const declared = { meter: DECLARED_METER };
// 'hello' is 5 bytes and requests ask for 10 tokens.
const RESERVED = 5 + FREE_METERING.declaredTemplateTokens + 10;
const CAPS = { dailyTokenCap: 10_000, perBuyerCap: 5_000 };
const INVALID = {
  code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INVALID_RESPONSE,
};
const reported =
  (inputTokens: number, outputTokens: number, text = 'answer') =>
  async () => ({
    text,
    usage: {
      inputTokens,
      outputTokens,
      totalDurationNs: 0,
      loadDurationNs: 0,
      inputDurationNs: 0,
      outputDurationNs: 0,
    },
    finishReason: ENGINE_DONE_REASONS.STOP,
  });

async function respond(
  state: Awaited<ReturnType<typeof freeSellerFixture>>,
  sequence = 1,
) {
  const request = await state.request(sequence);
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
  return { request, response };
}

void test('the buyer receives and accepts the provider’s declared usage', async () => {
  const state = await freeSellerFixture(CAPS, declared);
  state.setRun(reported(9, 3));
  const { request, response } = await respond(state);
  assert.deepEqual(response.result?.usage, { inputTokens: 9, outputTokens: 3 });
  assert.deepEqual(
    (await matchFreeExecutionResponse(response, request)).usage,
    {
      inputTokens: 9,
      outputTokens: 3,
    },
  );
});

void test('an implausible or out-of-bounds declared count is the provider’s invalid response', async () => {
  const per = FREE_METERING.declaredMaxTokenBytes;
  for (const run of [
    // Above maxTokens.
    reported(9, 11),
    // No input, or output below the text's byte floor.
    reported(0, 3),
    reported(9, 0),
    reported(9, 2, 'x'.repeat(per * 2 + 1)),
  ]) {
    const state = await freeSellerFixture(CAPS, declared);
    state.setRun(run);
    const { request, response } = await respond(state);
    assert.deepEqual(response.error, INVALID);
    await assert.rejects(matchFreeExecutionResponse(response, request), {
      code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    });
  }
  const state = await freeSellerFixture(CAPS, declared);
  state.setRun(reported(state.options.model.contextTokens, 1));
  assert.deepEqual((await respond(state)).response.error, INVALID);
});

void test('admission reserves the prompt’s bytes, the template allowance and maxTokens', async () => {
  const short = await freeSellerFixture(
    { dailyTokenCap: 1_000, perBuyerCap: RESERVED - 1 },
    declared,
  );
  assert.equal(
    (await respond(short)).response.error?.code,
    FREE_EXECUTION_CODES.BUYER_CAP,
  );
  const enough = await freeSellerFixture(
    { dailyTokenCap: 1_000, perBuyerCap: RESERVED },
    declared,
  );
  enough.setRun(reported(9, 3));
  assert.equal((await respond(enough)).response.error, undefined);
});

void test('a declared completion never refunds its reservation, whatever the provider reports', async () => {
  const state = await freeSellerFixture(
    { dailyTokenCap: 10_000, perBuyerCap: RESERVED * 2 },
    declared,
  );
  state.setRun(reported(1, 1));
  assert.equal((await respond(state, 1)).response.error, undefined);
  assert.equal((await respond(state, 2)).response.error, undefined);
  assert.equal(
    (await respond(state, 3)).response.error?.code,
    FREE_EXECUTION_CODES.BUYER_CAP,
  );
});

async function stream(
  fragments: readonly string[],
  end: () => Promise<EngineResult>,
) {
  const state = await freeStreamSellerFixture(CAPS, declared);
  state.setGenerate(async (input) => {
    for (const fragment of fragments) await input.onText?.(fragment);
    return end();
  });
  const request = await state.request();
  const delivered: string[] = [];
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
    async (text) => {
      delivered.push(text);
    },
  );
  return { response, delivered };
}

void test('a declared stream that stops reports its delivered bytes, bounded by maxTokens', async () => {
  for (const [fragments, outputTokens] of [
    [['an', 'swer'], 6],
    [['hello ', 'world!'], 10],
  ] as const) {
    const { response } = await stream(fragments, async () => {
      throw new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
    });
    assert.deepEqual(response.error, {
      code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
      reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
      delivered: { outputTokens },
    });
  }
});

void test('a declared stream stops before delivering more bytes than maxTokens allow', async () => {
  // Ten tokens allow at most 320 bytes.
  const chunk = 'x'.repeat(FREE_METERING.declaredMaxTokenBytes * 5);
  const { response, delivered } = await stream(
    [chunk, chunk, 'x'],
    reported(9, 10, chunk + chunk + 'x'),
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.LIMIT);
  assert.deepEqual(delivered, [chunk, chunk]);
});

void test('a declared stream completes with the provider’s usage, or stops as invalid with what it delivered', async () => {
  const done = await stream(['an', 'swer'], reported(9, 3));
  assert.deepEqual(done.response.result?.usage, {
    inputTokens: 9,
    outputTokens: 3,
  });
  const invalid = await stream(['an', 'swer'], reported(9, 11));
  assert.deepEqual(invalid.response.error, {
    ...INVALID,
    delivered: { outputTokens: 6 },
  });
});
