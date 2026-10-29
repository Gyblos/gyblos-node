// The buyer's quote window: long enough by default for a seller reached through a distant relay
// (the first real test measured about 250 ms per relay round trip), and set per buyer with
// `quoteWindowMs` in selection.json within fixed bounds. Synthetic loopback sellers; real timers.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
} from '@gyblos/buyer/constants';
import { raceControlOffers } from '@gyblos/buyer/offer-race';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

import { selectionFixture } from './support/buyer-selection';

const SLOW_QUOTE_MS = 1000;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

void test('by default a quote that takes one second still wins the race', async () => {
  const candidate: SellerCandidate = {
    nodeId: 'slow',
    owner: 'slow',
    listing: {} as SellerCandidate['listing'],
    reasoning: REASONING_LEVELS.OFF,
    downgrade: false,
    exploration: false,
    sticky: false,
    free: true,
    openChannel: false,
  };
  const quote = { offer: {}, signature: '' } as SignedOfferV2;
  const winner = await raceControlOffers([candidate], async () => {
    await delay(SLOW_QUOTE_MS);
    return quote;
  });
  assert.equal(winner?.candidate.nodeId, 'slow');
  assert.ok(BUYER_SELECTION.windowMs >= 3000);
});

void test('selection.json accepts quoteWindowMs only as an integer within bounds', async () => {
  const run = await selectionFixture();
  try {
    const base = JSON.parse(JSON.stringify(run.config)) as Record<
      string,
      unknown
    >;
    assert.equal('quoteWindowMs' in parseBuyerSelectionConfig(base), false);
    for (const value of [
      BUYER_SELECTION.minWindowMs,
      5000,
      BUYER_SELECTION.maxWindowMs,
    ])
      assert.equal(
        parseBuyerSelectionConfig({ ...base, quoteWindowMs: value })
          .quoteWindowMs,
        value,
      );
    for (const value of [
      0,
      BUYER_SELECTION.minWindowMs - 1,
      BUYER_SELECTION.maxWindowMs + 1,
      1500.5,
      '3000',
      null,
    ])
      assert.throws(
        () => parseBuyerSelectionConfig({ ...base, quoteWindowMs: value }),
        { code: BUYER_SELECTION_CODES.INVALID },
        String(value),
      );
  } finally {
    await run.wire.close();
  }
});

void test('the configured quote window decides whether a slow seller can answer', async () => {
  const run = await selectionFixture();
  try {
    const { windowMs: _default, ...dependencies } = run.dependencies;
    // Every quote from this seller arrives after SLOW_QUOTE_MS.
    const requestOffer = run.client.requestOffer.bind(run.client);
    run.client.requestOffer = async (...args) => {
      await delay(SLOW_QUOTE_MS);
      return requestOffer(...args);
    };
    const select = (quoteWindowMs: number) =>
      selectBuyerQuote(
        { ...run.config, quoteWindowMs },
        {
          ...dependencies,
          stats: new Map(),
          connect: async () => run.client,
        },
      );
    assert.deepEqual(await select(BUYER_SELECTION.minWindowMs), {
      ok: false,
      code: BUYER_SELECTION_CODES.NO_OFFER,
    });
    assert.equal((await select(2 * SLOW_QUOTE_MS + 1000)).ok, true);
  } finally {
    await run.wire.close();
  }
});
