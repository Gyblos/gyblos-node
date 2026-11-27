import { asc, inArray } from 'drizzle-orm';

import { createD1Orm, type D1Database } from './d1-client';
import { storedEntry, type ModelRegistryStore } from './model-registry';
import { modelRegistry } from './schema';
import { jsonTextValues } from './sqlite-expressions';

export function createD1ModelRegistry(client: D1Database): ModelRegistryStore {
  const database = createD1Orm(client);
  return {
    async get(modelIds) {
      if (modelIds.length === 0) return [];
      const rows = await database
        .select({
          modelId: modelRegistry.modelId,
          family: modelRegistry.family,
          lab: modelRegistry.lab,
          categories: modelRegistry.categories,
        })
        .from(modelRegistry)
        .where(inArray(modelRegistry.modelId, jsonTextValues(modelIds)))
        .orderBy(asc(modelRegistry.modelId));
      return rows.flatMap((row) =>
        storedEntry(row.modelId, row.family, row.lab, row.categories),
      );
    },
  };
}
