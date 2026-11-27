import type {
  ModelRegistryEntry,
  ModelRegistryStore,
} from '@gyblos/discovery-index/model-registry';

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
