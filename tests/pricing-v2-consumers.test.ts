// Checks per-million token pricing during seller selection.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';

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
