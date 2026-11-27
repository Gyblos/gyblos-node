// Each paid listing shows that seller’s price per million tokens. Selection requires confirmation.
import { MODEL_IDS } from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import {
  CATALOG_STATE,
  NETWORK_CATALOG,
  type NetworkCatalog,
} from '../catalog/model';
import { DESKTOP_X402 } from '../x402/constants';
import {
  ADDITIONAL_MODEL_ARTWORK,
  MODEL_CATEGORY,
  MODEL_SOURCE,
  MODELS,
} from './constants';
import type { CatalogModel, ModelArtwork, ModelOption } from './model-types';

export function modelArtwork(modelId: string): ModelArtwork {
  const family = modelId.toLowerCase().split('/').at(-1) ?? '';
  const matchesPrefix = (prefix: string) => {
    if (!family.startsWith(prefix)) return false;
    const suffix = family.slice(prefix.length);
    return suffix.length === 0 || /^[0-9:._-]/.test(suffix);
  };
  const additional = ADDITIONAL_MODEL_ARTWORK.find((item) =>
    matchesPrefix(item.prefix),
  );
  if (additional) return additional.image;
  const known = MODELS.find((model) => {
    if (model.id === 'oss')
      return (
        matchesPrefix('gpt-oss') || /^gpt-[0-9]+o?(?=$|[-.:])/.test(family)
      );
    return matchesPrefix(model.id);
  });
  return known?.image ?? { src: './assets/brand/gyblos-icon.png' };
}

export function announcedModels(
  catalog: NetworkCatalog,
  now: number,
): (CatalogModel & { prices: TokenPricesV2 })[] {
  if (
    catalog.state !== CATALOG_STATE.READY ||
    catalog.checkedAt === null ||
    now < catalog.checkedAt
  )
    return [];
  return catalog.models
    .filter((item) => item.expiresAt > now)
    .map((item) => {
      const input = Number(item.inputAtomicPerMtok) / DESKTOP_X402.AMOUNT_SCALE;
      const output =
        Number(item.outputAtomicPerMtok) / DESKTOP_X402.AMOUNT_SCALE;
      const { free } = item;
      return {
        id:
          item.offerId ??
          JSON.stringify([
            item.modelId,
            item.variant,
            item.quantization,
            item.contextTokens,
            free,
          ]),
        ...(item.offerId && { offerId: item.offerId }),
        name: item.modelId,
        family:
          [
            item.sellerFingerprint &&
              'Seller ' +
                item.sellerFingerprint.slice(
                  0,
                  NETWORK_CATALOG.OFFER_LABEL_DIGITS,
                ) +
                '…' +
                item.sellerFingerprint.slice(
                  -NETWORK_CATALOG.OFFER_LABEL_DIGITS,
                ),
            item.variant,
            item.quantization,
          ]
            .filter(Boolean)
            .join(' · ') || 'Signed announcement',
        image: modelArtwork(item.modelId),
        category: MODEL_CATEGORY.EVERYDAY,
        context: item.contextTokens.toLocaleString(),
        contextTokens: item.contextTokens,
        ...(item.variant && { variant: item.variant }),
        providers: item.announcements,
        free,
        input,
        output,
        prices: {
          inputAtomicPerMtok: item.inputAtomicPerMtok,
          outputAtomicPerMtok: item.outputAtomicPerMtok,
        },
        source: MODEL_SOURCE.ANNOUNCED,
      };
    });
}

export function chatNetworkOptions(models: readonly ModelOption[]) {
  return models.filter((item) => item.source === MODEL_SOURCE.ANNOUNCED);
}

export function networkModelGroups(models: readonly ModelOption[]) {
  const groups = new Map<string, ModelOption[]>();
  for (const item of chatNetworkOptions(models)) {
    const offers = groups.get(item.name);
    if (offers) offers.push(item);
    else groups.set(item.name, [item]);
  }
  return groups;
}

export function automaticOffersAvailable(
  name: string,
  offers: readonly Pick<ModelOption, 'name' | 'free'>[],
  paidAuto: boolean,
) {
  return offers.some(
    (item) =>
      item.name === name &&
      (item.free || (paidAuto && name === MODEL_IDS.QWEN3_0_6B)),
  );
}
