// Public shared routing policy rejects accidental authorizations and never widens the user's price ceilings.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fallbackPriceCeilings,
  parseBuyerRoutingPolicy,
} from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';

void test('routing defaults to reroute without permission to replace a pin or raise prices', () => {
  assert.deepEqual(parseBuyerRoutingPolicy(), {
    onBusy: BUYER_BUSY_POLICIES.REROUTE,
    queueWaitMs: 30000,
    allowPinnedFallback: false,
    allowHigherPriceFallback: false,
  });
});
void test('routing validates every explicit choice and refuses unknown or unimplemented fields', () => {
  assert.deepEqual(
    parseBuyerRoutingPolicy({
      onBusy: BUYER_BUSY_POLICIES.REJECT,
      allowPinnedFallback: true,
      allowHigherPriceFallback: true,
    }),
    {
      onBusy: BUYER_BUSY_POLICIES.REJECT,
      queueWaitMs: 30000,
      allowPinnedFallback: true,
      allowHigherPriceFallback: true,
    },
  );
  for (const value of [
    null,
    [],
    { onBusy: 'unsupported' },
    { onBusy: null },
    { allowPinnedFallback: 1 },
    { allowHigherPriceFallback: 'true' },
    { typo: true },
  ])
    assert.throws(() => parseBuyerRoutingPolicy(value), {
      code: BUYER_ROUTING_CODES.INVALID,
    });
});
void test('fallback compares both prices independently and intersects them with user ceilings', () => {
  assert.deepEqual(
    fallbackPriceCeilings(
      parseBuyerRoutingPolicy(),
      { inputAtomicPerMtok: '100', outputAtomicPerMtok: '80' },
      { inputAtomicPerMtok: '60', outputAtomicPerMtok: '200' },
    ),
    { inputAtomicPerMtok: '60', outputAtomicPerMtok: '80' },
  );
});
void test('free fallback stays free and explicit higher-price permission cannot widen user ceilings', () => {
  const limits = { inputAtomicPerMtok: '60', outputAtomicPerMtok: '200' };
  assert.deepEqual(
    fallbackPriceCeilings(
      parseBuyerRoutingPolicy(),
      { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      limits,
    ),
    { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  );
  assert.deepEqual(
    fallbackPriceCeilings(
      parseBuyerRoutingPolicy({ allowHigherPriceFallback: true }),
      { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      limits,
    ),
    limits,
  );
  assert.equal(
    fallbackPriceCeilings(
      parseBuyerRoutingPolicy({ allowHigherPriceFallback: true }),
      undefined,
      limits,
    ),
    undefined,
  );
});
