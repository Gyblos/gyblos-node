import {
  isModelCategory,
  type ModelCategory,
} from '@gyblos/protocol/model-categories';
import {
  MODEL_FAMILIES,
  MODEL_IDENTITY_SOURCE,
  modelIdentity,
  OTHER_FAMILY,
  type ModelFamily,
} from '@gyblos/protocol/model-family';

export type RegistryFamily = ModelFamily | typeof OTHER_FAMILY;

export interface ModelRegistryEntry {
  modelId: string;
  family: RegistryFamily;
  lab: string;
  categories: ModelCategory[];
}

export interface ModelRegistryStore {
  get(modelIds: readonly string[]): Promise<ModelRegistryEntry[]>;
}

export const isRegistryFamily = (value: unknown): value is RegistryFamily =>
  value === OTHER_FAMILY || MODEL_FAMILIES.some((family) => family === value);

export function registryEntry(
  modelId: string,
  family: unknown,
  lab: unknown,
  categories: unknown,
): ModelRegistryEntry {
  if (
    !isRegistryFamily(family) ||
    typeof lab !== 'string' ||
    !Array.isArray(categories) ||
    !categories.every(isModelCategory)
  )
    throw new TypeError('Unexpected model registry row.');
  return { modelId, family, lab, categories };
}

export function createMemoryModelRegistry(
  entries: readonly ModelRegistryEntry[] = [],
): ModelRegistryStore {
  const byId = new Map(entries.map((entry) => [entry.modelId, entry]));
  return {
    async get(modelIds) {
      return [...new Set(modelIds)].flatMap((modelId) => {
        const entry = byId.get(modelId);
        return entry ? [{ ...entry, categories: [...entry.categories] }] : [];
      });
    },
  };
}

export function catalogIdentity(
  modelId: string,
  entry: ModelRegistryEntry | undefined,
) {
  if (!entry) return { ...modelIdentity(modelId), categories: [] };
  return {
    family: entry.family,
    lab: entry.lab,
    source: MODEL_IDENTITY_SOURCE.REGISTRY,
    categories: entry.categories,
  };
}
