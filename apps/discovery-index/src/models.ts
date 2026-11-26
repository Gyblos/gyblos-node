// Owns GET /v1/models: every model live sellers list, and how many list it, so a buyer can offer the
// network's models by name before asking /v1/sellers for one. Takes no parameters; the answer is the
// same for everyone and cached like a sellers page.
import { DISCOVERY_INDEX_LIMITS, INDEX_ERRORS } from './constants';
import { indexFail } from './errors';
import { catalogIdentity, type ModelRegistryStore } from './model-registry';
import type { DiscoveryStorage } from './storage';

export function parseModelsQuery(url: string) {
  if (new URL(url).search !== '') indexFail(INDEX_ERRORS.INVALID_QUERY);
}

export async function modelsPage(storage: DiscoveryStorage, now: number) {
  const rows = await storage.models(now, DISCOVERY_INDEX_LIMITS.maxModels);
  const models = rows.map((row) => ({ id: row.modelId, sellers: row.sellers }));
  return JSON.stringify({ models, generatedAt: now });
}

export async function modelCatalogPage(
  storage: DiscoveryStorage,
  {
    now: clock,
    modelRegistry: registry,
  }: { now: () => number; modelRegistry: ModelRegistryStore | undefined },
) {
  const now = clock();
  const rows = await storage.models(now, DISCOVERY_INDEX_LIMITS.maxModels);
  const entries = registry
    ? await registry.get(rows.map((row) => row.modelId))
    : [];
  const byId = new Map(entries.map((entry) => [entry.modelId, entry]));
  const models = rows.map((row) => ({
    id: row.modelId,
    sellers: row.sellers,
    ...catalogIdentity(row.modelId, byId.get(row.modelId)),
  }));
  return JSON.stringify({ models, generatedAt: now });
}
