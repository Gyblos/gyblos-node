// Native encrypted A→B→A proves per-seller persistence and shared authority; finance/engine remain synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { inspectBatchPool } from '@gyblos/payments-upto/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';

import { multisellerSession } from '../support/multiseller-session';
import { endpoint, within } from '../support/native-fixture';
import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test(
  'native A to B to A reuses original seller channel after buyer restart with no intermediate payment sends',
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
    await within(
      buyer.execute(
        await fixture.offers[0]!.quote(1),
        fixture.offers[0]!.input,
        new AbortController().signal,
      ),
    );
    const original = (await inspectBatchPool(fixture.paths))[0]!.stored!
      .snapshot.channelId;
    await within(
      buyer.execute(
        await fixture.offers[1]!.quote(2),
        fixture.offers[1]!.input,
        new AbortController().signal,
      ),
    );
    await buyer.close();
    buyer = createBuyerSessionPool(options);
    await within(
      buyer.execute(
        await fixture.offers[0]!.quote(3),
        fixture.offers[0]!.input,
        new AbortController().signal,
      ),
    );
    const entries = await inspectBatchPool(fixture.paths);
    assert.equal(entries[0]!.stored!.snapshot.channelId, original);
    assert.equal(entries[0]!.stored!.snapshot.cumulativeAtomic, '80');
    assert.equal(entries[1]!.stored!.snapshot.cumulativeAtomic, '40');
    assert.deepEqual(fixture.a.calls, ['deposit']);
    assert.deepEqual(fixture.b.calls, ['deposit']);
    assert.equal(fixture.offers[0]!.generations(), 2);
    assert.equal(fixture.offers[1]!.generations(), 1);
  },
);
