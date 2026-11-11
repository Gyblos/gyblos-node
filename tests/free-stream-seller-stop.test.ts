// Proves how a streaming seller reports an engine that stops after admission: the stop reason and
// only the delivered output. Synthetic engines and tokenizers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recountedMeter } from '@gyblos/node/free-meter';
import {
  ENGINE_ERROR_CODES,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';

import { freeStreamSellerFixture as fixture } from './support/free-stream-seller';

void test('free seller reports delivered usage when the engine stops mid-stream', async () => {
  const state = await fixture();
  state.setGenerate(async (input) => {
    await input.onText?.('an');
    await input.onText?.('swer');
    throw new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
  });
  const request = await state.request();
  const fragments: string[] = [];
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      fragments.push(text);
    },
  );
  assert.deepEqual(fragments, ['an', 'swer']);
  assert.deepEqual(response.error, {
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
    delivered: { outputTokens: 2 },
  });
});
void test('free seller counts only fragments whose delivery resolved', async () => {
  const state = await fixture();
  state.setGenerate(async (input) => {
    await input.onText?.('an');
    await input.onText?.('swer').catch(() => {});
    throw new EngineError(ENGINE_ERROR_CODES.QUOTA_EXHAUSTED);
  });
  const request = await state.request();
  let deliveries = 0;
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {
      deliveries++;
      if (deliveries === 2) throw new Error('synthetic delivery failure');
    },
  );
  assert.deepEqual(response.error, {
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
    delivered: { outputTokens: 1 },
  });
});
void test('free seller omits delivered usage when the engine stops before any fragment', async () => {
  const state = await fixture();
  state.setGenerate(async () => {
    throw new EngineError(ENGINE_ERROR_CODES.RATE_LIMITED);
  });
  const request = await state.request();
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {},
  );
  assert.deepEqual(response.error, {
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.RATE_LIMITED,
  });
});
void test('free seller reports at least one delivered token and refuses codes outside the catalog', async () => {
  const state = await fixture();
  const service = (await import('@gyblos/node/free-execution'))
    .createSellerFreeExecution;
  const zero = service({
    ...state.options,
    meter: recountedMeter({ input: () => 4, chat: () => 4, count: () => 0 }),
    engine: {
      ...state.options.engine,
      async generate(input) {
        await input.onText?.('an');
        throw new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
      },
    },
  });
  const request = await state.request();
  const peer = request.quote.offer.buyerNodeId;
  const signal = new AbortController().signal;
  assert.deepEqual(
    (await zero.stream(request, peer, signal, async () => {})).error,
    {
      code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
      reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
      delivered: { outputTokens: 1 },
    },
  );
  const unknown = new EngineError(ENGINE_ERROR_CODES.INTERRUPTED);
  Object.defineProperty(unknown, 'code', { value: 'ENGINE_FUTURE_CODE' });
  state.setGenerate(async () => {
    throw unknown;
  });
  const second = await state.request(2);
  assert.deepEqual(
    (await state.service.stream(second, peer, signal, async () => {})).error,
    { code: FREE_EXECUTION_CODES.ENGINE },
  );
});
void test('free seller never reports more delivered tokens than delivered bytes', async () => {
  const state = await fixture();
  const { createSellerFreeExecution } =
    await import('@gyblos/node/free-execution');
  const service = createSellerFreeExecution({
    ...state.options,
    // Within maxTokens during delivery, then a normalising recount of the stopped text exceeds its bytes.
    meter: recountedMeter({
      input: () => 4,
      chat: () => 4,
      count: (text: string) => (text === 'an' ? 9 : 1),
    }),
    engine: {
      ...state.options.engine,
      async generate(input) {
        await input.onText?.('a');
        await input.onText?.('n');
        throw new EngineError(ENGINE_ERROR_CODES.QUOTA_EXHAUSTED);
      },
    },
  });
  const request = await state.request();
  const response = await service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {},
  );
  assert.deepEqual(response.error, {
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
    delivered: { outputTokens: 2 },
  });
});
