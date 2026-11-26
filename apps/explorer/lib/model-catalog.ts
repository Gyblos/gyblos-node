import { MODEL_CATEGORIES } from '@gyblos/protocol/constants';
import {
  FAMILY_NAMES,
  MODEL_FAMILIES,
  MODEL_IDENTITY_SOURCE,
  modelIdentity,
  type ModelFamily,
} from '@gyblos/protocol/model-family';

import { list, record, text } from './validate';

export interface CatalogModel {
  family: ModelFamily | null;
  lab: string;
  classified: boolean;
  categories: string[];
}
export type CatalogModels = Record<string, CatalogModel>;
export interface ModelView extends CatalogModel {
  familyName: string | null;
}

const knownFamily = (value: unknown): ModelFamily | null =>
  MODEL_FAMILIES.find((family) => family === value) ?? null;

function categoriesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return MODEL_CATEGORIES.filter((category) => value.includes(category));
}

export function parseCatalogModels(value: unknown): CatalogModels {
  const models: CatalogModels = {};
  for (const raw of list(record(value, 'catalog').models, 'catalog.models')) {
    const entry = record(raw, 'catalog.model');
    const classified = entry.source === MODEL_IDENTITY_SOURCE.REGISTRY;
    models[text(entry.id, 'catalog.model.id')] = {
      family: knownFamily(entry.family),
      lab: text(entry.lab, 'catalog.model.lab'),
      classified,
      categories: classified ? categoriesOf(entry.categories) : [],
    };
  }
  return models;
}

export function modelView(
  models: Readonly<CatalogModels> | null | undefined,
  modelId: string,
): ModelView {
  const listed = models?.[modelId];
  const identity = modelIdentity(modelId);
  const model = listed ?? {
    family: knownFamily(identity.family),
    lab: identity.lab,
    classified: false,
    categories: [],
  };
  return {
    family: model.family,
    familyName: model.family ? FAMILY_NAMES[model.family] : null,
    lab: model.lab,
    categories: [...model.categories],
    classified: model.classified,
  };
}

export function modelMaker(view: Pick<ModelView, 'lab' | 'familyName'>) {
  const { lab, familyName } = view;
  return familyName && !lab.toLowerCase().includes(familyName.toLowerCase())
    ? `${lab} · ${familyName}`
    : lab;
}
