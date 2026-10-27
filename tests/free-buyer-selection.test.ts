// Free selection reuses public signature/identity filters and never requests a paid quote.
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';

import { selectionFixture } from './support/buyer-selection';

void test('zero-price selection filters a paid listing before requesting a quote', async () => {
  const source = await selectionFixture();
  let quotes = 0;
  try {
    const result = await selectVerifiedBuyerQuote(
      {
        ...source.config,
        request: {
          ...source.config.request,
          maxAtomic: '0',
          priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
        },
      },
      {
        ...source.dependencies,
        connect: async () => ({
          ...source.client,
          getCatalog: source.client.getCatalog.bind(source.client),
          getPresence: source.client.getPresence.bind(source.client),
          close: source.client.close.bind(source.client),
          requestOffer: async (...args) => {
            quotes++;
            return source.client.requestOffer(...args);
          },
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(quotes, 0);
  } finally {
    await source.wire.close();
  }
});
