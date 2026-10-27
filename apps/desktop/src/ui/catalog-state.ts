// Filters the single illustrative catalog for both its list and empty state.
// No discovery, provider availability check or inference call is made.
import { MODEL_FILTER } from './constants';
import type { CatalogModel } from './model-types';

export type ModelFilter = (typeof MODEL_FILTER)[keyof typeof MODEL_FILTER];
export function matchesCatalog(
  model: CatalogModel,
  search: string,
  filter: ModelFilter,
): boolean {
  return (
    `${model.name} ${model.family}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()) &&
    (filter === MODEL_FILTER.ALL ||
      (filter === MODEL_FILTER.FREE && model.free) ||
      model.category === filter)
  );
}
export { MODEL_FILTER, MODELS, MODE_NAV, UI_VIEW } from './constants';
