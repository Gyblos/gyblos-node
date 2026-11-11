// A live verified quote bounds fallback without re-entering an occupied seller's transport slot.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import {
  createBuyerRouter,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';

import { batchDeferred } from './support/batch-deferred';
import { multisellerSession } from './support/multiseller-session';

for (const expired of [false, true]) {
  void test(`occupied seller uses its live verified quote as fallback reference; expired=${expired}`, async (t) => {
    const source = await multisellerSession();
    const entered = batchDeferred<void>();
    const finish = batchDeferred<void>();
    const aQuote = await source.offers[0]!.quote(1);
    const bQuote = await source.offers[1]!.quote(2);
    let now = aQuote.offer.issuedAt;
    let references = 0;
    let bCalls = 0;
    const router = createBuyerRouter({
      policy: parseBuyerRoutingPolicy({ allowPinnedFallback: true }),
      pinnedNodeId: source.a.terms.sellerNodeId,
      priceCeilings: aQuote.offer.prices,
      unresolved: async () => false,
      reference: async () => {
        references++;
        throw new Error('The seller transport is occupied');
      },
      now: () => now,
    });
    t.after(async () => {
      finish.resolve();
      await router.close();
      await source.close();
    });
    const ports: BuyerRoutePorts<string> = {
      select: async (excluded) => {
        const quote = excluded.has(source.a.terms.sellerNodeId)
          ? bQuote
          : aQuote;
        return { nodeId: quote.offer.nodeId, quote };
      },
      free: async () => assert.fail('priced quotes only'),
      paid: async (winner) => {
        if (winner.nodeId === source.b.terms.sellerNodeId) {
          bCalls++;
          return 'B';
        }
        entered.resolve();
        await finish.promise;
        return 'A';
      },
    };
    const first = router.execute(ports, AbortSignal.timeout(3000));
    await entered.promise;
    if (expired) now = aQuote.offer.expiresAt;
    const second = router.execute(ports, AbortSignal.timeout(3000));
    if (expired)
      await assert.rejects(second, { code: BUYER_ROUTING_CODES.BUSY });
    else assert.equal((await second).result, 'B');
    finish.resolve();
    assert.equal((await first).result, 'A');
    assert.equal(references, 0);
    assert.equal(bCalls, expired ? 0 : 1);
  });
}
