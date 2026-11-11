// Native encrypted A→B→A proves per-seller persistence and shared authority; finance/engine remain synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { BUYER_BUSY_POLICIES } from '@gyblos/core/constants';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import {
  createBuyerRouter,
  type BuyerRoutePorts,
} from '@gyblos/node/buyer-routing';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { inspectBatchPool } from '@gyblos/payments-upto/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

import { batchDeferred } from '../support/batch-deferred';
import { multisellerSession } from '../support/multiseller-session';
import { endpoint, within } from '../support/native-fixture';
import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test(
  'native queued requests refresh their quote and reuse the same A deposit without executing B',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const buyerEndpoint = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
    const sellers = await Promise.all([
      endpoint(undefined, [BATCH_CHANNEL.alpn]),
      endpoint(undefined, [BATCH_CHANNEL.alpn]),
    ]);
    const fixture = await multisellerSession({
      buyerNodeId: buyerEndpoint.id().toString(),
      sellers: sellers.map((peer) => peer.id().toString()),
    });
    t.mock.method(Date, 'now', fixture.a.now);
    const servers = sellers.map((peer, index) =>
      serveSellerTransport(
        peer,
        {
          free: undefined,
          batchSessions: createSellerBatchSession({
            session: fixture.rigs[index]!.seller(),
            terms: fixture.rigs[index]!.terms,
            offers: () => [fixture.offers[index]!.live],
            now: fixture.a.now,
          }),
        },
        {
          relayOnly: false,
          limits: { transport: TRANSPORT_LIMITS, maxFreeBuyers: 1 },
        },
      ),
    );
    const options = {
      ...fixture.options,
      endpoint: buyerEndpoint,
      destination: (terms: typeof fixture.a.terms) =>
        sellers[
          terms.sellerNodeId === fixture.a.terms.sellerNodeId ? 0 : 1
        ]!.addr(),
    };
    const sending = new Map<string, () => void>();
    const buyer = createBuyerSessionPool({
      ...options,
      transport: {
        beforeExecute: (request) =>
          sending.get(request.quote.offer.requestId)?.(),
      },
    });
    const router = createBuyerRouter({
      policy: parseBuyerRoutingPolicy({
        onBusy: BUYER_BUSY_POLICIES.WAIT,
        queueWaitMs: 5000,
        allowPinnedFallback: true,
      }),
      pinnedNodeId: fixture.a.terms.sellerNodeId,
      priceCeilings: fixture.offers[0]!.base.prices,
      unresolved: buyer.unresolved,
      reference: async () => fixture.offers[0]!.base.prices,
    });
    let quotes = 0;
    const ports: BuyerRoutePorts<string> = {
      select: async (_excluded, _signal, route) => {
        assert.equal(route.pinnedNodeId, fixture.a.terms.sellerNodeId);
        const quote = await fixture.offers[0]!.quote(++quotes);
        return { nodeId: quote.offer.nodeId, quote };
      },
      free: async () => assert.fail('priced quote'),
      paid: async (winner, signal, onSending) => {
        if (onSending) sending.set(winner.quote.offer.requestId, onSending);
        try {
          return (
            await buyer.execute(winner.quote, fixture.offers[0]!.input, signal)
          ).value.text;
        } finally {
          sending.delete(winner.quote.offer.requestId);
        }
      },
    };
    t.after(async () => {
      await router.close();
      await buyer.close();
      await buyerEndpoint.close();
      for (const server of servers) await server.close();
      await fixture.close();
    });
    const entered = batchDeferred<void>();
    const finish = batchDeferred<void>();
    fixture.offers[0]!.generate(async () => {
      entered.resolve();
      await finish.promise;
      return {
        text: 'ok!',
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalDurationNs: 0,
          loadDurationNs: 0,
          inputDurationNs: 0,
          outputDurationNs: 0,
        },
      };
    });
    t.after(() => finish.resolve());
    const first = router.execute(ports, AbortSignal.timeout(10000));
    await within(entered.promise);
    const original = (await inspectBatchPool(fixture.paths))[0]!.stored!
      .snapshot.channelId;
    const second = router.execute(ports, AbortSignal.timeout(10000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.offers[0]!.generations(), 1);
    assert.deepEqual(fixture.a.calls, ['deposit']);
    finish.resolve();
    assert.equal((await within(first)).result, 'ok!');
    assert.equal((await within(second)).result, 'ok!');
    const entries = await inspectBatchPool(fixture.paths);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.stored!.snapshot.channelId, original);
    assert.ok(quotes >= 2);
    for (const entry of entries)
      assert.equal(entry.stored!.snapshot.cumulativeAtomic, '80');
    assert.deepEqual(fixture.a.calls, ['deposit']);
    assert.deepEqual(fixture.b.calls, []);
    assert.equal(fixture.offers[1]!.generations(), 0);
  },
);
