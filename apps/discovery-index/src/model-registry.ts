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
  type ModelIdentity,
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

function parsedCategories(json: unknown): unknown {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as unknown) : null;
  } catch {
    return null;
  }
}

export function storedEntry(
  modelId: unknown,
  family: unknown,
  lab: unknown,
  json: unknown,
): ModelRegistryEntry[] {
  const categories = parsedCategories(json);
  return typeof modelId === 'string' &&
    isRegistryFamily(family) &&
    typeof lab === 'string' &&
    Array.isArray(categories) &&
    categories.every(isModelCategory)
    ? [{ modelId, family, lab, categories }]
    : [];
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
): ModelIdentity & { categories: ModelCategory[] } {
  if (!entry) return { ...modelIdentity(modelId), categories: [] };
  return {
    family: entry.family,
    lab: entry.lab,
    source: MODEL_IDENTITY_SOURCE.REGISTRY,
    categories: entry.categories,
  };
}
