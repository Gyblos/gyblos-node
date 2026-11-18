// Reuses verified HTTP discovery, then projects the requested model's listings: free ones, and paid ones
// priced in devnet USDC (the asset this app pays with), each group with its cheapest price.
// Signatures identify announcements, not registry trust, provider readiness or availability.
import { DEVNET, DEVNET_USDC, DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  fetchSellers,
  type DiscoveredSeller,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';

import { CATALOG_STATE, NETWORK_CATALOG } from './constants';
import type { AnnouncedModel, NetworkCatalog } from './model';

type Pricing = DiscoveredSeller['catalog']['models'][number]['pricing'];

const isFree = (pricing: Pricing) =>
  pricing.inputAtomicPerMtok === '0' && pricing.outputAtomicPerMtok === '0';

// A paid listing is shown only when its price is in an asset this app can show and pay.
const isShown = (pricing: Pricing) =>
  isFree(pricing) ||
  (pricing.network === DEVNET && pricing.asset === DEVNET_USDC);

const cheaper = (left: string, right: string) =>
  BigInt(left) <= BigInt(right) ? left : right;

function project(
  sellers: DiscoveredSeller[],
  modelId: string,
  checkedAt: number,
) {
  const models = new Map<string, AnnouncedModel>();
  let truncated = false;
  for (const seller of sellers) {
    const seen = new Set<string>();
    for (const model of seller.catalog.models) {
      const expiresAt = Math.min(
        seller.catalog.expiresAt,
        seller.presence.expiresAt,
      );
      if (
        model.modelId !== modelId ||
        expiresAt <= checkedAt ||
        !isShown(model.pricing)
      )
        continue;
      const key = JSON.stringify([
        model.modelId,
        model.variant,
        model.quantization,
        model.contextTokens,
        isFree(model.pricing),
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const held = models.get(key);
      if (held) {
        held.announcements += 1;
        held.expiresAt = Math.min(held.expiresAt, expiresAt);
        held.inputAtomicPerMtok = cheaper(
          held.inputAtomicPerMtok,
          model.pricing.inputAtomicPerMtok,
        );
        held.outputAtomicPerMtok = cheaper(
          held.outputAtomicPerMtok,
          model.pricing.outputAtomicPerMtok,
        );
      } else if (models.size < NETWORK_CATALOG.MAX_MODELS)
        models.set(key, {
          modelId: model.modelId,
          variant: model.variant,
          quantization: model.quantization,
          contextTokens: model.contextTokens,
          announcements: 1,
          expiresAt,
          inputAtomicPerMtok: model.pricing.inputAtomicPerMtok,
          outputAtomicPerMtok: model.pricing.outputAtomicPerMtok,
        });
      else truncated = true;
    }
  }
  return { models: [...models.values()], truncated };
}
export async function readAnnouncements(
  fetch: DiscoveryFetch,
  model: string,
  now: () => number,
  signal: AbortSignal,
): Promise<NetworkCatalog> {
  const page = await fetchSellers({
    baseUrl: DISCOVERY_INDEX_URL,
    model,
    fetch,
    now,
    signal,
    limit: NETWORK_CATALOG.MAX_ANNOUNCEMENTS,
    timeoutMs: NETWORK_CATALOG.REQUEST_MS,
  });
  const checkedAt = now();
  const result = project(page.sellers, model, checkedAt);
  return {
    state: result.models.length ? CATALOG_STATE.READY : CATALOG_STATE.EMPTY,
    query: model,
    checkedAt,
    models: result.models,
    truncated: result.truncated || page.next !== null,
  };
}
