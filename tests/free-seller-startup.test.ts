// Tests prepared-offer composition without reading configuration, starting engines or opening paid services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSellerFreeExecution } from '@gyblos/node/free-execution';
import { defaultSellerOffer } from '@gyblos/node/seller-offer';
import {
  FREE_EXECUTION_CODES,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller.js';

void test('free startup omits the handler for a prepared paid offer without invoking an engine', async () => {
  const state = await freeSellerFixture();
  assert.equal(
    prepareSellerFreeExecution({
      ...state.options,
      offer: defaultSellerOffer(),
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
