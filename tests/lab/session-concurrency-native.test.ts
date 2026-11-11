// Native encrypted A→B→A proves per-seller persistence and shared authority; finance/engine remain synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
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
  'native A and B generate concurrently within unchanged limits and retain separate cumulative approvals',
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
    let buyer = createBuyerSessionPool(options);
    t.after(async () => {
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
    const a = buyer.execute(
      await fixture.offers[0]!.quote(1),
      fixture.offers[0]!.input,
      AbortSignal.timeout(10000),
    );
    await within(entered.promise);
    try {
      const b = await within(
        buyer.execute(
          await fixture.offers[1]!.quote(2),
          fixture.offers[1]!.input,
          AbortSignal.timeout(10000),
        ),
      );
      assert.equal(b.value.text, 'ok!');
      assert.equal(fixture.offers[0]!.generations(), 1);
    } finally {
      finish.resolve();
      await a;
    }
    const entries = await inspectBatchPool(fixture.paths);
    assert.equal(entries.length, 2);
    for (const entry of entries)
      assert.equal(entry.stored!.snapshot.cumulativeAtomic, '40');
    assert.deepEqual(fixture.a.calls, ['deposit']);
    assert.deepEqual(fixture.b.calls, ['deposit']);
  },
);
