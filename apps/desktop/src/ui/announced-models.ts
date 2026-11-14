// Maps sanitized announcements into shared preview controls; never authorizes inference.
import { CATALOG_STATE, type NetworkCatalog } from '../catalog/model';
import {
  ADDITIONAL_MODEL_ARTWORK,
  MODEL_CATEGORY,
  MODEL_SOURCE,
  MODELS,
} from './constants';
import type { CatalogModel, ModelArtwork } from './model-types';

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
): CatalogModel[] {
  if (
    catalog.state !== CATALOG_STATE.READY ||
    catalog.checkedAt === null ||
    now < catalog.checkedAt
  )
    return [];
  return catalog.models
    .filter((item) => item.expiresAt > now)
    .map((item) => {
      return {
        id: JSON.stringify([
          item.modelId,
          item.variant,
          item.quantization,
          item.contextTokens,
        ]),
        name: item.modelId,
        family:
          [item.variant, item.quantization].filter(Boolean).join(' · ') ||
          'Signed announcement',
        image: modelArtwork(item.modelId),
        category: MODEL_CATEGORY.EVERYDAY,
        context: item.contextTokens.toLocaleString(),
        providers: item.announcements,
        free: true,
        input: 0,
        output: 0,
        source: MODEL_SOURCE.ANNOUNCED,
      };
    });
}
