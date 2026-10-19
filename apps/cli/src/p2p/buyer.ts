import { readFile } from 'node:fs/promises';

import { EndpointAddr, EndpointId, RelayMode } from '@number0/iroh';

import {
  verifyInferenceOffer,
  type OfferTrust,
} from '@gyblos/application/offers';
import { MAX_ATOMIC, P2P } from '@gyblos/config';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { saveJson } from '@gyblos/runtime';
import type { TransportRoute } from '@gyblos/transport';
import { bindEndpoint } from '@gyblos/transport/endpoint';
import { createIrohTransport } from '@gyblos/transport/iroh-client';

import { startBuyerProxy } from './proxy.js';
import { loadRole, nodeSecret, rolePath } from './roles.js';

export async function trustedOffer() {
  const config = await loadRole();
  if (config.role !== 'buyer') throw new Error('Buyer role required.');
  const trust = JSON.parse(
    await readFile(rolePath(P2P.trustFilename), 'utf8'),
  ) as OfferTrust;
  if (
    trust.buyer !== config.buyer ||
    trust.mint !== config.mint ||
    BigInt(trust.maxAtomic) > BigInt(MAX_ATOMIC)
  )
    throw new Error('Local buyer trust configuration mismatch.');
  const bytes = await readFile(rolePath(P2P.offerFilename));
  if (bytes.length > P2P.bodyBytes) throw new Error('Offer exceeds bounds.');
  const offer = await verifyInferenceOffer(
    JSON.parse(bytes.toString('utf8')),
    trust,
  );
  if (
    offer.endpoint.relayUrl &&
    !RelayMode.defaultMode()
      .relayMap()
      .urls()
      .some(
        (url) => new URL(url).href === new URL(offer.endpoint.relayUrl!).href,
      )
  )
    throw new Error('Unconfigured relay rejected.');
  return { config, offer, trust };
}

export async function startBuyer() {
  const { config, offer } = await trustedOffer();
  await assertProgram(config.rpcUrl);
  const endpoint = await bindEndpoint(await nodeSecret(), {
    bindAddress: process.env.GYBLOS_IROH_BIND,
  });
  if (endpoint.id().toString() !== config.nodeId)
    throw new Error('Buyer node key mismatch.');
  const remote = new EndpointAddr(
    EndpointId.fromString(offer.nodeId),
    offer.endpoint.relayUrl,
    offer.relayOnly ? [] : offer.endpoint.directAddresses,
  );
  const transport = createIrohTransport(endpoint, remote, offer.nodeId);
  const expected = process.env.GYBLOS_EXPECTED_ROUTE;
  if (expected && !['iroh-direct', 'iroh-relay'].includes(expected))
    throw new Error('Invalid expected route.');
  await transport.ready(expected as TransportRoute | undefined);
  const proxy = await startBuyerProxy(transport);
  await saveJson(rolePath(P2P.statusFilename), {
    status: 'ready',
    runId: process.env.GYBLOS_P2P_RUN_ID,
    role: 'buyer',
    nodeId: config.nodeId,
    sellerNodeId: offer.nodeId,
  });
  return proxy;
}
