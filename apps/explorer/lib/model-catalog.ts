import {
  sortedCategories,
  type ModelCategory,
} from '@gyblos/protocol/model-categories';
import {
  FAMILY_NAMES,
  MODEL_FAMILIES,
  MODEL_IDENTITY_SOURCE,
  modelIdentity,
  namedFamily,
  type ModelFamily,
} from '@gyblos/protocol/model-family';

import { list, record, text } from './validate';

export interface CatalogModel {
  family: ModelFamily | null;
  lab: string;
  classified: boolean;
  categories: ModelCategory[];
}
export type CatalogModels = Record<string, CatalogModel>;
export interface ModelView extends CatalogModel {
  familyName: string | null;
}

const knownFamily = (value: unknown): ModelFamily | null =>
  MODEL_FAMILIES.find((family) => family === value) ?? null;

const categoriesOf = (value: unknown) =>
  Array.isArray(value)
    ? sortedCategories(value.filter((item) => typeof item === 'string'))
    : [];

export function parseCatalog(value: unknown) {
  const models: CatalogModels = Object.create(null) as CatalogModels;
  const ids: string[] = [];
  for (const raw of list(record(value, 'catalog').models, 'catalog.models')) {
    const entry = record(raw, 'catalog.model');
    const id = text(entry.id, 'catalog.model.id');
    const classified = entry.source === MODEL_IDENTITY_SOURCE.REGISTRY;
    const model = {
      family: knownFamily(entry.family),
      lab: text(entry.lab, 'catalog.model.lab'),
      classified,
      categories: classified ? categoriesOf(entry.categories) : [],
    };
    if (!Object.hasOwn(models, id)) ids.push(id);
    Object.defineProperty(models, id, {
      value: model,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ids, models };
}

function catalogModel(
  models: Readonly<CatalogModels> | null | undefined,
  modelId: string,
): CatalogModel {
  if (models && Object.hasOwn(models, modelId)) {
    const listed = models[modelId];
    if (listed) return listed;
  }
  const identity = modelIdentity(modelId);
  return {
    family: knownFamily(identity.family),
    lab: identity.lab,
    classified: false,
    categories: [],
  };
}

export function modelView(
  models: Readonly<CatalogModels> | null | undefined,
  modelId: string,
): ModelView {
  const model = catalogModel(models, modelId);
  const named =
    model.family !== null &&
    (model.classified || namedFamily(modelId) === model.family);
  return {
    family: model.family,
    familyName: named && model.family ? FAMILY_NAMES[model.family] : null,
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
