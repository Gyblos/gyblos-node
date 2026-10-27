// Shares isolated native control endpoints across control and identity admission contracts.
// Synthetic identities and loopback only; no real registry, engine or payment calls.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_ALPN, GYBLOS_ALPN } from '@gyblos/protocol/constants';
import { signPublicV2 } from '@gyblos/protocol/public-v2';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { controlFixture } from './control-fixture.js';
import { endpoint } from './native-fixture.js';

export async function nativeControlFixture(queryMs = 1000) {
  const source = await controlFixture();
  source.catalog.models[0]!.pricing.inputAtomicPerMtok = '1000000';
  source.catalog.models[0]!.pricing.outputAtomicPerMtok = '2000000';
  source.request.params.priceCeilings = {
    inputAtomicPerMtok: '3000000',
    outputAtomicPerMtok: '3000000',
  };
  const seller = await endpoint();
  seller.setAlpns(
    [GYBLOS_ALPN, CONTROL_ALPN].map((alpn) => [...Buffer.from(alpn)]),
  );
  const buyer = await endpoint();
  source.catalog.nodeId = seller.id().toString();
  source.context.nodeId = source.catalog.nodeId;
  source.context.endpoint = {
    relayUrl: null,
    directAddresses: seller.addr().directAddresses(),
  };
  source.context.relayOnly = false;
  const nodeSigner = async (bytes: Uint8Array<ArrayBuffer>) =>
    Uint8Array.from(
      seller
        .secretKey()
        .sign([...bytes])
        .toBytes(),
    );
  source.context.catalog = await signPublicV2(source.catalog, nodeSigner);
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner,
  });
  let httpRequests = 0;
  const http = createServer((_request, response) => {
    httpRequests++;
    response.writeHead(403);
    response.end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const server = serveIroh(seller, `http://127.0.0.1:${address.port}`, false, {
    ...service,
    queryMs,
  });
  const transport = createControlTransport(
    buyer,
    seller.addr(),
    seller.id().toString(),
    { queryMs: 2000 },
  );
  const client = createBuyerControlClient(transport, {
    ...source.trust(),
    now: source.context.now,
  });
  return {
    ...source,
    seller,
    buyer,
    server,
    client,
    get httpRequests() {
      return httpRequests;
    },
    async close() {
      await client.close();
      await buyer.close();
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
