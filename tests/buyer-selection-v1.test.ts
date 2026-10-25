// Keeps control quotes advisory: incompatible v2 terms cannot enter the unchanged v1 execution flow.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import type { SelectionDecision } from '@gyblos/buyer/selection';
import { requireLegacyQuoteCompatibility } from '@gyblos/buyer/selection-v1';
import { createControlQuote } from '@gyblos/core/control-quotes';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { InferenceOffer } from '@gyblos/protocol/offer';

import { controlFixture } from './support/control-fixture.js';

void test('a smaller selected quote budget cannot authorize against a larger trusted v1 maximum', async () => {
  const run = await controlFixture();
  const quote = await createControlQuote(
    run.request,
    run.context,
    run.ownerSigner,
  );
  quote.offer.prices = {
    inputAtomicPerMtok: '1000000',
    outputAtomicPerMtok: '2000000',
  };
  const trusted: InferenceOffer = {
    ...quote.offer,
    prices: { inputAtomic: '1', outputAtomic: '2' },
    maxAtomic: '10000',
  };
  const result: SelectionDecision = {
    ok: true,
    winner: { quote, candidate: {} as SellerCandidate },
  };
  assert.deepEqual(requireLegacyQuoteCompatibility(result, trusted), {
    ok: false,
    code: BUYER_SELECTION_CODES.V1_INCOMPATIBLE,
  });
  trusted.maxAtomic = quote.offer.maxAtomic;
  assert.equal(requireLegacyQuoteCompatibility(result, trusted).ok, true);
  quote.offer.reasoning = REASONING_LEVELS.LOW;
  assert.equal(requireLegacyQuoteCompatibility(result, trusted).ok, false);
  quote.offer.reasoning = REASONING_LEVELS.OFF;
  trusted.prices = { ...trusted.prices, inputAtomic: '2' };
  assert.equal(requireLegacyQuoteCompatibility(result, trusted).ok, false);
});
