// Composes opt-in buyer selection with the native endpoint and the existing trusted v1 transport.
// Control connections close before HTTP readiness; neither this module nor quotes authorize payment.
import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import type { HomeEnvironment } from '@gyblos/config/home';
import type { DiscoveryFetch } from '@gyblos/discovery-http';
import type { BuyerIdentityVerifier } from '@gyblos/node/identity-verifier';
import type { InferenceOffer } from '@gyblos/protocol/offer';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

import { BUYER_SELECTION_CODES } from './constants';
import { connectBuyerControl } from './control';
import { discoverBuyerSellers } from './discovery';
import { buyerDiscoveryState } from './discovery-storage';
import {
  prepareBuyerIdentity,
  requireBuyerIdentity,
  verifyBuyerIdentity,
} from './identity';
import { selectBuyerQuote, type SelectionDecision } from './selection';
import {
  BuyerSelectionError,
  loadBuyerSelectionConfig,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';
import { createProxySelection } from './selection-proxy';
import { selectionStats } from './selection-stats';
import { requireLegacyQuoteCompatibility } from './selection-v1';

export interface PreparedBuyerSelection {
  config: BuyerSelectionConfig;
  stats: Awaited<ReturnType<typeof selectionStats>>;
  discovery: Awaited<ReturnType<typeof buyerDiscoveryState>> | undefined;
  identity?: BuyerIdentityVerifier;
}
export async function prepareBuyerSelection(
  environment: HomeEnvironment,
): Promise<PreparedBuyerSelection | undefined> {
  const config = await loadBuyerSelectionConfig(environment);
  if (!config) return undefined;
  return prepareConfiguredBuyerSelection(environment, config);
}
// Compose state from the validated startup snapshot; never reopen selection.json here.
export async function prepareConfiguredBuyerSelection(
  environment: HomeEnvironment,
  config: BuyerSelectionConfig,
): Promise<PreparedBuyerSelection> {
  const stats = await selectionStats(environment);
  const configured = new Set(config.sellers.map((seller) => seller.nodeId));
  for (const nodeId of stats.rows.keys())
    if (!configured.has(nodeId)) stats.rows.delete(nodeId);
  const discovery = config.discovery
    ? await buyerDiscoveryState(
        environment,
        config.discovery.open
          ? { configuredNodeIds: [...configured] }
          : undefined,
      )
    : undefined;
  const identity = await prepareBuyerIdentity(environment, config);
  return { config, stats, discovery, identity };
}
export function runtimeProxySelection(
  prepared: NonNullable<Awaited<ReturnType<typeof prepareBuyerSelection>>>,
  options: {
    endpoint: Endpoint;
    now?: () => number;
    fetch?: DiscoveryFetch;
    trusted: InferenceOffer;
    buyer: string;
    relayOnly: boolean;
    retireIdle: () => Promise<boolean>;
  },
) {
  requireBuyerIdentity(prepared.config, prepared.identity);
  const now = options.now ?? Date.now;
  return createProxySelection(
    async (signal) => {
      if (!(await options.retireIdle()))
        throw new BuyerSelectionError(BUYER_SELECTION_CODES.RECONCILE);
      const config =
        prepared.config.discovery && prepared.discovery
          ? await discoverBuyerSellers(
              { ...prepared.config, discovery: prepared.config.discovery },
              prepared.discovery,
              {
                fetch: options.fetch ?? globalThis.fetch,
                now,
                signal,
                verifyIdentity: (seller, querySignal) =>
                  verifyBuyerIdentity(prepared.identity, seller, querySignal),
              },
            )
          : prepared.config;
      const result = await selectBuyerQuote(
        config,
        {
          buyer: options.buyer,
          verifyIdentity: (seller, querySignal) =>
            verifyBuyerIdentity(prepared.identity, seller, querySignal),
          now,
          trusted: options.trusted,
          stats: prepared.stats.rows,
          observeVerified: prepared.discovery
            ? (seller) =>
                prepared.discovery!.observe(seller, {
                  allowOwnerChange: Boolean(prepared.identity),
                })
            : undefined,
          connect: (seller) => connectSelectedSeller(seller, options, now),
        },
        signal,
      );
      if (
        'winner' in result &&
        prepared.discovery &&
        !(await prepared.discovery.permits(
          result.winner.candidate.owner,
          result.winner.candidate.nodeId,
          result.winner.quote.offer.catalogDigest,
          now(),
        ))
      ) {
        const stopped: SelectionDecision = {
          ok: false,
          code: BUYER_SELECTION_CODES.NO_OFFER,
        };
        return stopped;
      }
      await prepared.stats.save();
      return requireLegacyQuoteCompatibility(result, options.trusted);
    },
    prepared.config.request.maxTokens,
    now,
    identityAdmission(prepared),
  );
}

async function connectSelectedSeller(
  seller: StaticControlSeller,
  options: Parameters<typeof runtimeProxySelection>[1],
  now: () => number,
) {
  const remote = new EndpointAddr(
    EndpointId.fromString(seller.nodeId),
    seller.relayUrl ?? undefined,
    options.relayOnly ? [] : seller.directAddresses,
  );
  return connectBuyerControl(
    options.endpoint,
    remote,
    {
      owner: seller.owner,
      nodeId: seller.nodeId,
      now,
      relayAllowed: (origin) => {
        try {
          assertConfiguredRelay(origin);
          return true;
        } catch {
          return false;
        }
      },
    },
    options.relayOnly,
  );
}

function identityAdmission(prepared: PreparedBuyerSelection) {
  if (!prepared.identity) return undefined;
  return async (
    identity: { owner: string; nodeId: string },
    signal: AbortSignal,
  ) => {
    const seller = prepared.config.sellers.find(
      (item) =>
        item.nodeId === identity.nodeId && item.owner === identity.owner,
    );
    return Boolean(
      seller && (await verifyBuyerIdentity(prepared.identity, seller, signal)),
    );
  };
}
