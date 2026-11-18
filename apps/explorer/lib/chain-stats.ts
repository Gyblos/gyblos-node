// Owns the read of the collector's chain stats (GET /v1/stats/chain): the collector indexes the
// payment-channels program and aggregates it per day, so the explorer reads no RPC itself. Fetched,
// checked at the boundary (chain-shape.ts) on each render; the collector caches it at the edge.

import { parseChainStats, type ChainSnapshot } from './chain-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';

export type { ChainSnapshot } from './chain-shape';

export async function getChainStats(): Promise<ChainSnapshot> {
  try {
    return { ...(await loadChainStats()), error: null };
  } catch (error) {
    return {
      aggregatedAt: null,
      backfillDone: null,
      days: [],
      error: error instanceof Error ? error.message : 'chain stats unavailable',
    };
  }
}

async function loadChainStats() {
  return parseChainStats(
    await fetchJson(`${COLLECTOR_URL}/stats/chain`, 'collector chain'),
  );
}
