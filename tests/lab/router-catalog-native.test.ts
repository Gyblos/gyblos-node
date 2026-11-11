// Native product selection/reference regression; control signatures are real, execution and finances synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectWinner } from '@gyblos/buyer/free-selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { pinnedBusy, sessionRouter } from '@gyblos/buyer/session-routing';
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { SELLER_BADGES } from '@gyblos/core/constants';
import type { BuyerRoutePorts } from '@gyblos/node/buyer-routing';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { batchDeferred } from '../support/batch-deferred';
import { nativeControlFixture } from '../support/native-control';
import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test(
  'actual product catalog-reference fallback routes a protected-priced pin to B only after explicit permission',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const a = await nativeControlFixture();
    const b = await nativeControlFixture();
    t.mock.method(Date, 'now', a.context.now);
    const finish = batchDeferred<void>();
    const entered = batchDeferred<void>();
    let router: ReturnType<typeof sessionRouter> | undefined;
    try {
      const { buyer, buyerNodeId, catalogDigest, ...request } =
        a.request.params;
      const prepared = {
        discovery: undefined,
        config: {
          request: {
            ...request,
            lowestReasoning: null,
            minimumBadge: SELLER_BADGES.DECLARED_USAGE,
            retention: [a.catalog.dataPolicy.retention],
          },
          pinnedNodeId: a.catalog.nodeId,
          routing: parseBuyerRoutingPolicy({ allowPinnedFallback: true }),
          sellers: [a, b].map((source) => ({
            owner: source.catalog.owner,
            nodeId: source.catalog.nodeId,
            directAddresses: source.seller.addr().directAddresses(),
            relayUrl: null,
          })),
        } satisfies BuyerSelectionConfig,
        stats: { rows: new Map(), async save() {} },
      };
      const context = {
        prepared,
        endpoint: a.buyer,
        relayOnly: false,
        role: { role: P2P_ROLES.BUYER, buyer },
      };
      router = sessionRouter(
        context as unknown as Parameters<typeof sessionRouter>[0],
        async () => false,
      );
      const ports: BuyerRoutePorts<string> = {
        select: (excluded, signal, route) =>
          selectWinner(
            prepared,
            {
              endpoint: a.buyer,
              relayOnly: false,
              buyer,
              onPinnedBusy: pinnedBusy,
            },
            excluded,
            signal,
            { ...prepared.config.request, priceCeilings: route.priceCeilings },
            route,
          ),
        free: async () => assert.fail('Priced quotes must use the paid port'),
        paid: async (winner) => {
          if (winner.nodeId === a.catalog.nodeId) {
            entered.resolve();
            await finish.promise;
          }
          return winner.nodeId;
        },
      };
      const first = router.execute(ports, AbortSignal.timeout(5000));
      await entered.promise;
      try {
        const second = await router.execute(ports, AbortSignal.timeout(5000));
        assert.equal(second.result, b.catalog.nodeId);
        assert.equal(second.kind, 'paid');
      } finally {
        finish.resolve();
        await first;
      }
    } finally {
      finish.resolve();
      await router?.close();
      await a.close();
      await b.close();
    }
  },
);
