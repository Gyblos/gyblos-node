// Starts the buyer: verifies the stored signed offer against local trust, plans relay-only or direct
// dialing, binds the buyer's Iroh endpoint and opens the loopback proxy to the seller.
import { readFile } from 'node:fs/promises';

import { EndpointAddr, EndpointId } from '@number0/iroh';

import { BUYER_RELAY_ONLY_ENV, MAX_ATOMIC, P2P } from '@gyblos/config';
import {
  verifyInferenceOffer,
  type InferenceOffer,
  type OfferTrust,
} from '@gyblos/node/offers';
import { loadRole, nodeSecret, rolePath } from '@gyblos/node/roles';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { saveJson } from '@gyblos/runtime';
import {
  assertConfiguredRelay,
  bindEndpoint,
  requireConfiguredRelay,
  type BindEndpointOptions,
} from '@gyblos/transport-iroh/endpoint';
import { createIrohTransport } from '@gyblos/transport-iroh/iroh-client';
import { expectedIrohRoute } from '@gyblos/transport-iroh/route-policy';

import { startBuyerProxy } from './proxy.js';

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
  if (offer.endpoint.relayUrl) assertConfiguredRelay(offer.endpoint.relayUrl);
  return { config, offer, trust };
}

// The single buyer decision point for relay-only binding and seller dialing.
export function buyerConnectionPlan(
  offer: Pick<InferenceOffer, 'nodeId' | 'relayOnly' | 'endpoint'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const relayOnly = environment[BUYER_RELAY_ONLY_ENV] === '1';
  const offeredRelay = offer.endpoint.relayUrl;
  let relayUrl: string | undefined;
  if (relayOnly) relayUrl = requireConfiguredRelay(offeredRelay, environment);
  else if (offeredRelay)
    relayUrl = assertConfiguredRelay(offeredRelay, environment);
  const bindOptions: BindEndpointOptions = {
    relayOnly,
    bindAddress: relayOnly ? undefined : environment.GYBLOS_IROH_BIND,
    externalAddress: environment.GYBLOS_IROH_EXTERNAL_ADDR || undefined,
  };
  const remote = {
    nodeId: offer.nodeId,
    relayUrl,
    directAddresses:
      relayOnly || offer.relayOnly ? [] : offer.endpoint.directAddresses,
  };
  return { relayOnly, bindOptions, remote };
}

export async function startBuyer() {
  const { config, offer } = await trustedOffer();
  const plan = buyerConnectionPlan(offer);
  const remote = new EndpointAddr(
    EndpointId.fromString(plan.remote.nodeId),
    plan.remote.relayUrl,
    plan.remote.directAddresses,
  );
  await assertProgram(config.rpcUrl);
  const endpoint = await bindEndpoint(await nodeSecret(), plan.bindOptions);
  let cleanup = () => endpoint.close();
  try {
    if (endpoint.id().toString() !== config.nodeId)
      throw new Error('Buyer node key mismatch.');
    const transport = createIrohTransport(endpoint, remote, offer.nodeId);
    cleanup = () => transport.close();
    const expected = expectedIrohRoute(process.env.GYBLOS_EXPECTED_ROUTE);
    await transport.ready(expected);
    const proxy = await startBuyerProxy(transport);
    cleanup = () => proxy.close();
    await saveJson(rolePath(P2P.statusFilename), {
      status: 'ready',
      runId: process.env.GYBLOS_P2P_RUN_ID,
      role: 'buyer',
      nodeId: config.nodeId,
      sellerNodeId: offer.nodeId,
    });
    return proxy;
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // A parent owner may fail before releasing the native endpoint.
      await endpoint.close().catch(() => undefined);
    }
    throw error;
  }
}
