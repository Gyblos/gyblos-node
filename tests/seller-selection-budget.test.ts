// SELLER_PRICE_ABOVE_BUDGET is reported only when raising the budget would admit a seller: a listing
// at an acceptable reasoning level from a seller that is not cooling down.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';

import {
  history,
  nodeId,
  NOW,
  request,
  select,
  seller,
} from './support/seller-selection-fixture';

const { OFF } = REASONING_LEVELS;

void test('an over-budget listing counts as priced only at an acceptable reasoning level', () => {
  const zero = request({ maxAtomic: '0' });
  const offOnly = seller(1, { reasoning: [OFF], input: '50', output: '50' });
  const high = seller(2, { input: '50', output: '50' });
  assert.deepEqual(select([offOnly], { request: zero }), {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
  assert.deepEqual(select([offOnly, high], { request: zero }), {
    ok: false,
    code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET,
  });
  // A cooling seller is no candidate at any price.
  const cooling = new Map([[nodeId(2), history({ cooldownUntil: NOW + 1 })]]);
  assert.deepEqual(select([high], { request: zero, stats: cooling }), {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
});

void test('saved Auto rates preserve single atomic differences beyond display number precision', async () => {
  const { listingFitsBudget } = await import('@gyblos/core/seller-selection');
  const rates = {
    inputAtomicPerMtok: '9007199254740992',
    outputAtomicPerMtok: '1000000',
  };
  const budget = '9007199256';
  assert.equal(listingFitsBudget(rates, rates, budget), true);
  assert.equal(
    listingFitsBudget(
      { ...rates, inputAtomicPerMtok: '9007199254740993' },
      rates,
      budget,
    ),
    false,
  );
  assert.equal(listingFitsBudget(rates, rates, '9007199255'), false);
});
