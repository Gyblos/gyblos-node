// Exercises seller publication → real HTTP index → trusted buyer selection → signed control quote.
// TCP contract and gated native Iroh cases use temporary state/unfunded identities, never engines or payments.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { fetchSellers, publishRecord } from '@gyblos/discovery-http';
import { createSellerControlService } from '@gyblos/node/control';
import { createSellerPublisher } from '@gyblos/node/publisher';
import {
  CONTROL_ALPN,
  CONTROL_PAID_ALPN,
  GYBLOS_ALPN,
} from '@gyblos/protocol/constants';
import type { Signer } from '@gyblos/protocol/signing';
import {
  createControlTransport,
  type ControlTransport,
} from '@gyblos/transport-iroh/control-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { discoveryHome } from './support/buyer-discovery.js';
import { controlLoopback } from './support/control-loopback.js';
import { endpoint, within } from './support/native-fixture.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';
import { publicationIndex } from './support/publication-index.js';
import { sellerPublicationFixture } from './support/seller-publication.js';

function selectionConfig(
  run: Awaited<ReturnType<typeof sellerPublicationFixture>>,
  baseUrl: string,
): BuyerSelectionConfig & { discovery: { baseUrl: string; maxPages: number } } {
  const {
    buyer: _buyer,
    buyerNodeId: _node,
    catalogDigest: _digest,
    ...request
  } = run.request.params;
  return {
    request: {
      ...request,
      lowestReasoning: null,
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [run.catalog.dataPolicy.retention],
    },
    sellers: [
      {
        owner: run.catalog.owner,
        nodeId: run.catalog.nodeId,
        relayUrl: null,
        directAddresses: [],
      },
    ],
    discovery: { baseUrl, maxPages: 3 },
  };
}
async function discoverAndQuote(
  run: Awaited<ReturnType<typeof sellerPublicationFixture>>,
  transport: ControlTransport,
) {
  const index = await publicationIndex(run.context.now, run.catalog.nodeId);
  const buyer = await discoveryHome();
  const publication = createSellerPublisher({
    records: run.records,
    now: run.context.now,
    canPublish: () => true,
    publish: async (record, signal) => {
      await publishRecord({
        baseUrl: index.baseUrl,
        record,
        signal,
        fetch: globalThis.fetch,
      });
    },
  });
  const client = createBuyerControlClient(transport, {
    ...run.trust(),
    now: run.context.now,
  });
  try {
    assert.equal(await publication.tick(), true);
    const config = await discoverBuyerSellers(
      selectionConfig(run, index.baseUrl),
      buyer.state,
      { fetch: globalThis.fetch, now: run.context.now },
    );
    assert.equal(config.sellers.length, 1);
    const outcome = await selectBuyerQuote(config, {
      buyer: run.request.params.buyer,
      trusted: run.catalog,
      stats: new Map(),
      now: run.context.now,
      random: () => 0,
      connect: async () => client,
      observeVerified: (seller) => buyer.state.observe(seller),
    });
    assert.equal(outcome.ok, true);
    assert.ok('winner' in outcome);
    assert.equal(outcome.winner.quote.offer.protocol, CONTROL_PAID_ALPN);
    assert.equal(outcome.winner.quote.offer.buyerNodeId, transport.localNodeId);
    await publication.stop();
    const retired = await fetchSellers({
      baseUrl: index.baseUrl,
      model: run.catalog.models[0]!.modelId,
      fetch: globalThis.fetch,
      now: run.context.now,
    });
    assert.equal(retired.sellers.length, 0);
  } finally {
    await publication.stop();
    await client.close();
    await buyer.close();
    await index.close();
  }
}
void test('seller publishes through loopback HTTP index and buyer selects a signed Iroh-stream contract quote, then retirement removes listing', async () => {
  const run = await sellerPublicationFixture();
  const service = createSellerControlService({
    ...run,
    context: { ...run.context, catalog: run.records.current() },
    records: run.records,
  });
  const wire = await controlLoopback(service, run.request.params.buyerNodeId);
  try {
    await discoverAndQuote(run, {
      ...wire.transport,
      remoteNodeId: run.catalog.nodeId,
    });
  } finally {
    await wire.close();
    await run.close();
  }
});
void test(
  'seller publication reaches a verified quote through native encrypted Iroh without forwarding HTTP or running an engine',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns(
      [GYBLOS_ALPN, CONTROL_ALPN].map((alpn) => [...Buffer.from(alpn)]),
    );
    const signer: Signer = async (bytes) =>
      Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    const run = await sellerPublicationFixture({
      nodeId: seller.id().toString(),
      signer,
    });
    run.context.endpoint = {
      relayUrl: null,
      directAddresses: seller.addr().directAddresses(),
    };
    run.context.relayOnly = false;
    let forwarded = 0;
    const http = createServer((_request, response) => {
      forwarded++;
      response.writeHead(403).end();
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const service = createSellerControlService({
      ...run,
      nodeSigner: signer,
      context: { ...run.context, catalog: run.records.current() },
      records: run.records,
    });
    const bridge = serveIroh(
      seller,
      `http://127.0.0.1:${address.port}`,
      false,
      service,
    );
    const transport = createControlTransport(
      buyer,
      seller.addr(),
      seller.id().toString(),
      { queryMs: 2000 },
    );
    try {
      await within(discoverAndQuote(run, transport), 10000);
      assert.equal(forwarded, 0);
    } finally {
      await transport.close();
      await buyer.close();
      await bridge.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await run.close();
    }
  },
);
