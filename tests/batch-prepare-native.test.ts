// Native Iroh preparation returns metadata without opening a payment channel or running a model.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { BATCH_CHANNEL, BATCH_METHODS } from '@gyblos/protocol/batch-channel';
import { createBatchChannelClient } from '@gyblos/transport-iroh/batch-client';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

void test(
  'native Iroh PREPARE checks the actual peer before any financial or engine work',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const seller = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
    const buyer = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
    const rig = await sessionRig({
      buyerNodeId: buyer.id().toString(),
      sellerNodeId: seller.id().toString(),
    });
    const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
    const server = serveSellerTransport(
      seller,
      {
        free: undefined,
        batchSessions: createSellerBatchSession({
          session: rig.seller(),
          terms: rig.terms,
          offers: () => [offers.live],
          now: rig.now,
        }),
      },
      {
        relayOnly: false,
        limits: { transport: TRANSPORT_LIMITS, maxFreeBuyers: 1 },
      },
    );
    const client = createBatchChannelClient(
      buyer,
      seller.addr(),
      seller.id().toString(),
      { now: rig.now },
    );
    try {
      const result = await within(
        client.exchange({
          version: BATCH_CHANNEL.version,
          requestId: '12'.repeat(16),
          method: BATCH_METHODS.PREPARE,
          params: { quote: await offers.quote(1) },
        }),
      );
      assert.deepEqual(result.result, { terms: rig.terms });
      assert.equal(offers.generations(), 0);
      assert.deepEqual(rig.calls, []);
    } finally {
      await client.close();
      await client.settled();
      await buyer.close();
      await server.close();
      await rig.dispose();
    }
  },
);
