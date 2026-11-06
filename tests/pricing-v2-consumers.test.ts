// Prevents per-token/per-million confusion in selection and the unchanged trusted v1 execution boundary.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SelectionDecision } from '@gyblos/buyer/selection';
import { requireLegacyQuoteCompatibility } from '@gyblos/buyer/selection-v1';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { createControlQuote } from '@gyblos/core/control-quotes';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import type { InferenceOffer } from '@gyblos/protocol/offer';

import { controlFixture } from './support/control-fixture';
import {
  chosen,
  request,
  select,
  seller,
} from './support/seller-selection-fixture';

void test('seller minimum budget rounds the combined per-million cost of one input and output token', () => {
  const result = select([seller(1)], { request: request({ maxAtomic: '1' }) });
  assert.equal(chosen(result).length, 1);
  const costly = seller(2, { input: '1000000', output: '1000001' });
  const ceilings = {
    inputAtomicPerMtok: '1000000',
    outputAtomicPerMtok: '1000001',
  };
  assert.deepEqual(
    select([costly], {
      request: request({ maxAtomic: '2', priceCeilings: ceilings }),
    }),
    {
      ok: false,
      code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET,
    },
  );
  assert.equal(
    chosen(
      select([costly], {
        request: request({ maxAtomic: '3', priceCeilings: ceilings }),
      }),
    ).length,
    1,
  );
});

void test('advisory v2 rates must equal scaled trusted v1 rates before existing v1 execution can proceed', async () => {
  const run = await controlFixture();
  const quote = await createControlQuote(
    run.request,
    run.context,
    run.ownerSigner,
  );
  const trusted: InferenceOffer = {
    ...quote.offer,
    prices: { inputAtomic: '1', outputAtomic: '2' },
  };
  const result: SelectionDecision = {
    ok: true,
    winner: {
      quote: {
        ...quote,
        offer: {
          ...quote.offer,
          prices: {
            inputAtomicPerMtok: '1000000',
            outputAtomicPerMtok: '2000000',
          },
        },
      },
      candidate: {} as SellerCandidate,
    },
  };
  assert.equal(requireLegacyQuoteCompatibility(result, trusted).ok, true);
  result.winner.quote.offer.prices = {
    inputAtomicPerMtok: '1',
    outputAtomicPerMtok: '2',
  };
  assert.equal(requireLegacyQuoteCompatibility(result, trusted).ok, false);
});
