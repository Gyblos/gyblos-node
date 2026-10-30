// Owns bounded in-memory lookup state; never persists discoveries or reads wallet state.
import type { DiscoveryFetch } from '@gyblos/discovery-http';

import { emptyCatalog } from './model';

export function createCatalogSession(
  _fetch: DiscoveryFetch,
  _now: () => number,
  _signal: AbortSignal,
) {
  return {
    summary: () => emptyCatalog(),
    lookup: async (_model: string) => emptyCatalog(),
  };
}
