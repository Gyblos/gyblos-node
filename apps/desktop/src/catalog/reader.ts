// Reuses verified HTTP discovery, then projects only requested zero-price listings.
// Signatures identify announcements, not registry trust, provider readiness or availability.
import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  fetchSellers,
  type DiscoveredSeller,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';

import { CATALOG_STATE, NETWORK_CATALOG } from './constants';
import type { AnnouncedModel, NetworkCatalog } from './model';

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
        model.pricing.inputAtomicPerMtok !== '0' ||
        model.pricing.outputAtomicPerMtok !== '0'
      )
        continue;
      const key = JSON.stringify([
        model.modelId,
        model.variant,
        model.quantization,
        model.contextTokens,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const held = models.get(key);
      if (held) {
        held.announcements += 1;
        held.expiresAt = Math.min(held.expiresAt, expiresAt);
      } else if (models.size < NETWORK_CATALOG.MAX_MODELS)
        models.set(key, {
          modelId: model.modelId,
          variant: model.variant,
          quantization: model.quantization,
          contextTokens: model.contextTokens,
          announcements: 1,
          expiresAt,
        });
      else truncated = true;
    }
  }
  return { models: [...models.values()], truncated };
}
export async function readFreeAnnouncements(
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
