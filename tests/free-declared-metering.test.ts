// A free offer whose provider declares usage: the buyer receives the provider's counts within the same
// bounds it verifies, admission reserves a byte bound, and a stop reports delivered bytes. Synthetic
// engines; no tokenizer, files or network.
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
import { EngineError } from '@gyblos/protocol/engine';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';
import { freeStreamSellerFixture } from './support/free-stream-seller';

const declared = { meter: DECLARED_METER };
const reported = (inputTokens: number, outputTokens: number) => async () => ({
  text: 'answer',
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

async function respond(state: Awaited<ReturnType<typeof freeSellerFixture>>) {
  const request = await state.request();
  return state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
}

void test('the buyer receives the provider’s declared usage', async () => {
  const state = await freeSellerFixture(undefined, declared);
  state.setRun(reported(9, 3));
  const response = await respond(state);
  assert.deepEqual(response.result?.usage, { inputTokens: 9, outputTokens: 3 });
});

void test('declared output above maxTokens is refused as the buyer would', async () => {
  const state = await freeSellerFixture(undefined, declared);
  state.setRun(reported(9, 11));
  assert.equal((await respond(state)).error?.code, FREE_EXECUTION_CODES.LIMIT);
});

void test('declared usage beyond the model context is refused as the buyer would', async () => {
  const state = await freeSellerFixture(undefined, declared);
  state.setRun(reported(state.options.model.contextTokens, 1));
  assert.equal((await respond(state)).error?.code, FREE_EXECUTION_CODES.LIMIT);
});

void test('admission reserves the prompt’s bytes, the template allowance and maxTokens', async () => {
  // 'hello' is 5 bytes; requests ask for 10 tokens.
  const reserved = 5 + FREE_METERING.declaredTemplateTokens + 10;
  const short = await freeSellerFixture(
    { dailyTokenCap: 1_000, perBuyerCap: reserved - 1 },
    declared,
  );
  assert.equal(
    (await respond(short)).error?.code,
    FREE_EXECUTION_CODES.BUYER_CAP,
  );
  const enough = await freeSellerFixture(
    { dailyTokenCap: 1_000, perBuyerCap: reserved },
    declared,
  );
  enough.setRun(reported(9, 3));
  assert.equal((await respond(enough)).error, undefined);
});

void test('a declared stream that stops reports its delivered bytes, bounded by maxTokens', async () => {
  for (const [fragments, delivered] of [
    [['an', 'swer'], 6],
    [['hello ', 'world!'], 10],
  ] as const) {
    const state = await freeStreamSellerFixture(undefined, declared);
    state.setGenerate(async (input) => {
      for (const fragment of fragments) await input.onText?.(fragment);
      throw new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
    });
    const request = await state.request();
    const response = await state.service.stream(
      request,
      request.quote.offer.buyerNodeId,
      freeSellerSignal(),
      async () => {},
    );
    assert.deepEqual(response.error, {
      code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
      reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
      delivered: { outputTokens: delivered },
    });
  }
});

void test('a declared stream completes with the provider’s usage', async () => {
  const state = await freeStreamSellerFixture(undefined, declared);
  state.setGenerate(async (input) => {
    await input.onText?.('an');
    await input.onText?.('swer');
    return reported(9, 3)();
  });
  const request = await state.request();
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
    async () => {},
  );
  assert.deepEqual(response.result?.usage, { inputTokens: 9, outputTokens: 3 });
});
