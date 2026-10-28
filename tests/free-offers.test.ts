// Free execution over several offers: each offer spends its own token caps, single use spans the whole
// seller, and an offer warmed later is served from then on. Synthetic offers and quotes from the real
// control service; no engines, files or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FreeSellerLedger } from '@gyblos/core/free-admission';
import { createSellerFreeOffers } from '@gyblos/node/free-offers';
import type { LiveSellerOffer } from '@gyblos/node/seller-offer-set';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

import {
  BUYER_NODE,
  offerControlFixture,
} from './support/seller-offer-control';

async function fixture() {
  const run = await offerControlFixture();
  // 'hello' is 5 input tokens and 'answer' 6 output tokens; a request reserves 5 + maxTokens 10.
  run.a.live.offer.caps = { dailyTokenCap: 20, perBuyerCap: 20 };
  const offers: LiveSellerOffer[] = [run.a.live];
  const free = createSellerFreeOffers(() => offers, {
    owner: run.owner,
    nodeId: run.nodeId,
    now: () => run.now,
    ledger: new FreeSellerLedger(run.now - 1, 10),
  });
  const execute = async (live: LiveSellerOffer, id: number) => {
    const quoted = await run.quote(live, id);
    if (!('result' in quoted) || !quoted.result || !('offer' in quoted.result))
      throw new Error(JSON.stringify(quoted));
    const quote: SignedOfferV2 = quoted.result.offer;
    return free.respond(
      {
        version: FREE_EXECUTION.version,
        requestId: quote.offer.requestId,
        quote,
        input: {
          messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
          selection: quote.offer.selection,
          reasoning: quote.offer.reasoning,
          maxTokens: 10,
        },
      },
      BUYER_NODE,
      new AbortController().signal,
    );
  };
  return { ...run, offers, execute };
}

void test('one offer’s spent caps leave another offer’s untouched', async () => {
  const run = await fixture();
  run.offers.push(run.b.live);
  assert.equal((await run.execute(run.a.live, 1)).result?.text, 'answer');
  assert.equal(
    (await run.execute(run.a.live, 2)).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
  const other = await run.execute(run.b.live, 3);
  assert.equal(other.error, undefined, JSON.stringify(other.error));
});

void test('a request id is single use across the seller’s offers', async () => {
  const run = await fixture();
  run.offers.push(run.b.live);
  assert.equal((await run.execute(run.a.live, 7)).error, undefined);
  assert.equal(
    (await run.execute(run.b.live, 7)).error?.code,
    FREE_EXECUTION_CODES.REPLAY,
  );
});

void test('an offer not yet warmed is UNSUPPORTED, then served once it is added', async () => {
  const run = await fixture();
  assert.equal(
    (await run.execute(run.b.live, 1)).error?.code,
    FREE_EXECUTION_CODES.UNSUPPORTED,
  );
  run.offers.push(run.b.live);
  assert.equal((await run.execute(run.b.live, 2)).error, undefined);
});

void test('an offer’s caps survive while it leaves and rejoins the served offers', async () => {
  const run = await fixture();
  assert.equal((await run.execute(run.a.live, 1)).error, undefined);
  run.offers.splice(0);
  run.offers.push(run.a.live);
  assert.equal(
    (await run.execute(run.a.live, 2)).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
});
