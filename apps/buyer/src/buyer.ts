// Owns buyer in buyer; it must not know laboratory orchestration.
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
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';
import {
  assertConfiguredRelay,
  bindEndpoint,
  RelayConfigurationError,
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
  const relayUrl = offer.endpoint.relayUrl
    ? assertConfiguredRelay(offer.endpoint.relayUrl)
    : undefined;
  return { config, offer, trust, relayUrl };
}

export function buyerRelayOnly(environment: NodeJS.ProcessEnv = process.env) {
  return environment[BUYER_RELAY_ONLY_ENV] === '1';
}

export function bindBuyerEndpoint(
  secret: number[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return bindEndpoint(secret, {
    relayOnly: buyerRelayOnly(environment),
    bindAddress: environment.GYBLOS_IROH_BIND,
    externalAddress: environment.GYBLOS_IROH_EXTERNAL_ADDR || undefined,
  });
}

export function sellerAddress(
  offer: Pick<InferenceOffer, 'nodeId' | 'relayOnly' | 'endpoint'>,
  relayUrl: string | undefined,
  relayOnly: boolean,
) {
  if (relayOnly && !relayUrl)
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.RELAY_REQUIRED,
      `${BUYER_RELAY_ONLY_ENV}=1 requires a configured relay in the seller offer.`,
    );
  return new EndpointAddr(
    EndpointId.fromString(offer.nodeId),
    relayUrl,
    relayOnly || offer.relayOnly ? [] : offer.endpoint.directAddresses,
  );
}

export async function startBuyer() {
  const { config, offer, relayUrl } = await trustedOffer();
  const remote = sellerAddress(offer, relayUrl, buyerRelayOnly());
  await assertProgram(config.rpcUrl);
  const endpoint = await bindBuyerEndpoint(await nodeSecret());
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
