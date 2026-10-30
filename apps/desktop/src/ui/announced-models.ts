// Maps sanitized announcements into shared preview controls; never authorizes inference.
import { CATALOG_STATE, type NetworkCatalog } from '../catalog/model';
import { MODEL_CATEGORY, MODEL_SOURCE, MODELS } from './constants';
import type { CatalogModel } from './model-types';

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
      const family = item.modelId.toLowerCase();
      const known = MODELS.find((model) =>
        family.includes(model.id === 'oss' ? 'gpt-oss' : model.id),
      );
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
        image: known?.image ?? { src: './assets/brand/gyblos-icon.png' },
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
