// Composes opt-in buyer selection with the native endpoint and the existing trusted v1 transport.
// Control connections close before HTTP readiness; neither this module nor quotes authorize payment.
import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import type { HomeEnvironment } from '@gyblos/config/home';
import type { InferenceOffer } from '@gyblos/protocol/offer';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

import { BUYER_SELECTION_CODES } from './constants.js';
import { connectBuyerControl } from './control.js';
import {
  BuyerSelectionError,
  loadBuyerSelectionConfig,
} from './selection-config.js';
import { createProxySelection } from './selection-proxy.js';
import { selectionStats } from './selection-stats.js';
import { requireLegacyQuoteCompatibility } from './selection-v1.js';
import { selectBuyerQuote } from './selection.js';

export async function prepareBuyerSelection(environment: HomeEnvironment) {
  const config = await loadBuyerSelectionConfig(environment);
  if (!config) return undefined;
  const stats = await selectionStats(environment);
  const configured = new Set(config.sellers.map((seller) => seller.nodeId));
  for (const nodeId of stats.rows.keys())
    if (!configured.has(nodeId)) stats.rows.delete(nodeId);
  return { config, stats };
}
export function runtimeProxySelection(
  prepared: NonNullable<Awaited<ReturnType<typeof prepareBuyerSelection>>>,
  options: {
    endpoint: Endpoint;
    trusted: InferenceOffer;
    buyer: string;
    relayOnly: boolean;
    retireIdle: () => Promise<boolean>;
  },
) {
  return createProxySelection(async (signal) => {
    if (!(await options.retireIdle()))
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.RECONCILE);
    const result = await selectBuyerQuote(
      prepared.config,
      {
        buyer: options.buyer,
        trusted: options.trusted,
        stats: prepared.stats.rows,
        async connect(seller) {
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
        },
      },
      signal,
    );
    await prepared.stats.save();
    return requireLegacyQuoteCompatibility(result, options.trusted);
  }, prepared.config.request.maxTokens);
}
