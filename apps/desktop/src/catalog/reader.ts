// Projects verified listings. Paid offers retain a main-process binding to one seller and price pair.
import { createHash } from 'node:crypto';

import { DEVNET, DEVNET_USDC, DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  fetchSellers,
  type DiscoveredSeller,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';
import type { BuyerSellerChoice as CatalogSellerChoice } from '@gyblos/protocol/buyer-api';

import { CATALOG_STATE, NETWORK_CATALOG } from './constants';
import type { AnnouncedModel, NetworkCatalog } from './model';

type Pricing = DiscoveredSeller['catalog']['models'][number]['pricing'];

const isFree = (pricing: Pricing) =>
  pricing.inputAtomicPerMtok === '0' && pricing.outputAtomicPerMtok === '0';

// A paid listing is shown only when its price is in an asset this app can show and pay.
const isShown = (pricing: Pricing) =>
  isFree(pricing) ||
  (pricing.network === DEVNET && pricing.asset === DEVNET_USDC);

export type { BuyerSellerChoice as CatalogSellerChoice } from '@gyblos/protocol/buyer-api';

function project(
  sellers: DiscoveredSeller[],
  modelId: string,
  checkedAt: number,
  choices?: Map<string, CatalogSellerChoice>,
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
        isFree(model.pricing)
          ? null
          : [
              seller.catalog.nodeId,
              seller.catalog.owner,
              model.pricing.inputAtomicPerMtok,
              model.pricing.outputAtomicPerMtok,
            ],
      ]);
      const { inputAtomicPerMtok, outputAtomicPerMtok } = model.pricing;
      if (seen.has(key)) continue;
      seen.add(key);
      const held = models.get(key);
      if (held) {
        held.announcements += 1;
        held.expiresAt = Math.min(held.expiresAt, expiresAt);
      } else if (models.size < NETWORK_CATALOG.MAX_MODELS) {
        const offerId = isFree(model.pricing)
          ? undefined
          : createHash('sha256').update(key).digest('hex');
        if (offerId)
          choices?.set(offerId, {
            nodeId: seller.catalog.nodeId,
            owner: seller.catalog.owner,
            modelId,
            variant: model.variant,
            quantization: model.quantization,
            contextTokens: model.contextTokens,
            inputAtomicPerMtok,
            outputAtomicPerMtok,
            expiresAt,
          });
        models.set(key, {
          ...(offerId && {
            offerId,
            sellerFingerprint: createHash('sha256')
              .update(seller.catalog.nodeId)
              .digest('hex'),
          }),
          modelId: model.modelId,
          variant: model.variant,
          quantization: model.quantization,
          contextTokens: model.contextTokens,
          announcements: 1,
          expiresAt,
          free: isFree(model.pricing),
          inputAtomicPerMtok,
          outputAtomicPerMtok,
        });
      } else truncated = true;
    }
  }
  return { models: [...models.values()], truncated };
}
export async function readAnnouncements(
  fetch: DiscoveryFetch,
  model: string,
  now: () => number,
  signal: AbortSignal,
  choices?: Map<string, CatalogSellerChoice>,
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
  const result = project(page.sellers, model, checkedAt, choices);
  return {
    state: result.models.length ? CATALOG_STATE.READY : CATALOG_STATE.EMPTY,
    query: model,
    checkedAt,
    models: result.models,
    truncated: result.truncated || page.next !== null,
  };
}
