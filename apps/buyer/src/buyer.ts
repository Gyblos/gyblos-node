// Starts the buyer: verifies the stored signed offer against local trust, plans relay-only or direct
// dialing, binds the buyer's Iroh endpoint and opens the loopback proxy to the seller.
import { readFile } from 'node:fs/promises';

import { EndpointAddr, EndpointId } from '@number0/iroh';

import { BUYER_RELAY_ONLY_ENV, MAX_ATOMIC, ROLE_FILES } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/node/constants';
import { parseOfferTrustJson, verifyInferenceOffer } from '@gyblos/node/offers';
import { loadRole, nodeSecret, rolePath } from '@gyblos/node/roles';
import { assertProgram } from '@gyblos/payments-x402/chain';
import type { InferenceOffer } from '@gyblos/protocol/offer';
import { saveJson } from '@gyblos/runtime';
import { HTTP_OVER_IROH } from '@gyblos/transport-iroh/constants';
import {
  assertConfiguredRelay,
  bindEndpoint,
  requireConfiguredRelay,
  type BindEndpointOptions,
} from '@gyblos/transport-iroh/endpoint';
import { createIrohTransport } from '@gyblos/transport-iroh/iroh-client';
import { expectedIrohRoute } from '@gyblos/transport-iroh/route-policy';

import { startBuyerProxy } from './proxy.js';
import {
  prepareBuyerSelection,
  runtimeProxySelection,
} from './selection-runtime.js';

export async function trustedOffer() {
  const config = await loadRole(P2P_ROLES.BUYER);
  if (config.role !== P2P_ROLES.BUYER) throw new Error('Buyer role required.');
  const trust = parseOfferTrustJson(
    await readFile(rolePath(P2P_ROLES.BUYER, ROLE_FILES.trust), 'utf8'),
  );
  if (
    trust.buyer !== config.buyer ||
    trust.mint !== config.mint ||
    BigInt(trust.maxAtomic) > BigInt(MAX_ATOMIC)
  )
    throw new Error('Local buyer trust configuration mismatch.');
  const bytes = await readFile(rolePath(P2P_ROLES.BUYER, ROLE_FILES.offer));
  if (bytes.length > HTTP_OVER_IROH.bodyBytes)
    throw new Error('Offer exceeds bounds.');
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
  const preparedSelection = await prepareBuyerSelection(process.env);
  const plan = buyerConnectionPlan(offer);
  const remote = new EndpointAddr(
    EndpointId.fromString(plan.remote.nodeId),
    plan.remote.relayUrl,
    plan.remote.directAddresses,
  );
  await assertProgram(config.rpcUrl);
  const endpoint = await bindEndpoint(
    await nodeSecret(P2P_ROLES.BUYER),
    plan.bindOptions,
  );
  let cleanup = () => endpoint.close();
  try {
    if (endpoint.id().toString() !== config.nodeId)
      throw new Error('Buyer node key mismatch.');
    const transport = createIrohTransport(endpoint, remote, offer.nodeId);
    cleanup = () => transport.close();
    const expected = expectedIrohRoute(process.env.GYBLOS_EXPECTED_ROUTE);
    if (!preparedSelection) await transport.ready(expected);
    const selection = preparedSelection
      ? runtimeProxySelection(preparedSelection, {
          endpoint,
          trusted: offer,
          buyer: config.buyer,
          relayOnly: plan.relayOnly,
          retireIdle: () => transport.retireIdle(),
        })
      : undefined;
    const proxyTransport = preparedSelection
      ? {
          ...transport,
          async exchange(request: Parameters<typeof transport.exchange>[0]) {
            await transport.ready(expected);
            return transport.exchange(request);
          },
        }
      : transport;
    const proxy = await startBuyerProxy(proxyTransport, selection);
    cleanup = () => proxy.close();
    await saveJson(rolePath(P2P_ROLES.BUYER, ROLE_FILES.status), {
      status: 'ready',
      runId: process.env.GYBLOS_P2P_RUN_ID,
      role: P2P_ROLES.BUYER,
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
