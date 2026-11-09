// Tests prepared-offer composition without reading configuration, starting engines or opening paid services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSellerFreeExecution } from '@gyblos/node/free-execution';
import {
  FREE_EXECUTION_CODES,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';

void test('free startup omits the handler for a prepared paid offer without invoking an engine', async () => {
  const state = await freeSellerFixture();
  assert.equal(
    prepareSellerFreeExecution({
      ...state.options,
      offer: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        reasoning: [REASONING_LEVELS.OFF],
        kind: OFFER_PRICING_KINDS.PAID,
        prices: { inputAtomicPerMtok: '1', outputAtomicPerMtok: '2' },
      },
      catalog: state.source.context.catalog,
    }),
    undefined,
  );
  assert.equal(state.calls(), 0);
});
void test('free startup takes selection and shared caps from its prepared catalog and offer', async () => {
  const state = await freeSellerFixture({ dailyTokenCap: 14, perBuyerCap: 14 });
  const service = prepareSellerFreeExecution({
    ...state.options,
    catalog: state.source.context.catalog,
  });
  assert.ok(service);
  const first = await state.request();
  assert.ok(
    (
      await service.respond(
        first,
        first.quote.offer.buyerNodeId,
        freeSellerSignal(),
      )
    ).result,
  );
  const next = await state.request(2, 'f'.repeat(64));
  assert.equal(
    (
      await service.respond(
        next,
        next.quote.offer.buyerNodeId,
        freeSellerSignal(),
      )
    ).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
  assert.equal(state.calls(), 1);
});
void test('free startup refuses a prepared catalog missing its configured offer', async () => {
  const state = await freeSellerFixture();
  const record = state.source.context.catalog.record;
  assert.equal(record.kind, PUBLIC_RECORD_KINDS.CATALOG);
  if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG)
    throw new Error('Synthetic catalog required');
  assert.throws(
    () =>
      prepareSellerFreeExecution({
        ...state.options,
        catalog: {
          ...state.source.context.catalog,
          record: { ...record, models: [] },
        },
      }),
    { code: FREE_EXECUTION_CODES.INTERNAL },
  );
  assert.equal(state.calls(), 0);
});
void test('free startup refuses a selection the seller does not serve before checking the signature', async () => {
  const state = await freeSellerFixture();
  const service = prepareSellerFreeExecution({
    ...state.options,
    catalog: state.source.context.catalog,
  });
  assert.ok(service);
  const signed = await state.request();
  const other = { ...signed.quote.offer.selection, modelId: 'qwen3-8b' };
  // Changing the selection also breaks the owner's quote signature.
  const unsigned = {
    ...signed,
    quote: {
      ...signed.quote,
      offer: { ...signed.quote.offer, selection: other },
    },
    input: { ...signed.input, selection: other },
  };
  const buyer = signed.quote.offer.buyerNodeId;
  for (const response of [
    await service.respond(unsigned, buyer, freeSellerSignal()),
    await service.stream(unsigned, buyer, freeSellerSignal(), async () => {}),
  ])
    assert.equal(response.error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(state.calls(), 0);
});
