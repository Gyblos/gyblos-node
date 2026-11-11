// Shared synthetic router fixture; no socket, funded wallet or real inference/payment service.
import assert from 'node:assert/strict';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { BUYER_BUSY_POLICIES } from '@gyblos/core/constants';
import {
  createBuyerRouter,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';

import { multisellerSession } from './multiseller-session';

export async function routingQueueFixture(
  queueWaitMs = 1000,
  unresolved: () => Promise<boolean> = async () => false,
) {
  const source = await multisellerSession();
  let quotes = 0;
  const router = createBuyerRouter({
    policy: parseBuyerRoutingPolicy({
      onBusy: BUYER_BUSY_POLICIES.WAIT,
      queueWaitMs,
      allowPinnedFallback: true,
    }),
    pinnedNodeId: source.a.terms.sellerNodeId,
    priceCeilings: {
      inputAtomicPerMtok: '9000000',
      outputAtomicPerMtok: '9000000',
    },
    unresolved,
    reference: async () => source.offers[0]!.base.prices,
  });
  const ports: BuyerRoutePorts<string> = {
    select: async (_excluded, _signal, route) => {
      assert.equal(route.pinnedNodeId, source.a.terms.sellerNodeId);
      const quote = await source.offers[0]!.quote(++quotes);
      return { nodeId: quote.offer.nodeId, quote };
    },
    free: async () => assert.fail('priced quote'),
    paid: async () => 'answer',
  };
  return {
    router,
    source,
    ports,
    quotes: () => quotes,
    close: async () => {
      await router.close();
      await source.close();
    },
  };
}
