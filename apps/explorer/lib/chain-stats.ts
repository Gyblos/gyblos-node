// Owns the read of the collector's chain stats (GET /v1/stats/chain): the collector indexes the
// payment-channels program and aggregates it per day, so the explorer reads no RPC itself. Fetched,
// checked at the boundary (chain-shape.ts) on each render; the collector caches it at the edge.

import { parseChainStats, type ChainSnapshot } from './chain-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';
import { rangeQuery, type RangeDays } from './range';

export type { ChainSnapshot } from './chain-shape';

// `periodsBack` 1 reads the span of the same length just before the range, for a change.
export async function getChainStats(
  days: RangeDays,
  periodsBack = 0,
): Promise<ChainSnapshot> {
  try {
    return { ...(await loadChainStats(days, periodsBack)), error: null };
  } catch (error) {
    return {
      aggregatedAt: null,
      backfillDone: null,
      days: [],
      error: error instanceof Error ? error.message : 'chain stats unavailable',
    };
  }
}

async function loadChainStats(days: RangeDays, periodsBack: number) {
  return parseChainStats(
    await fetchJson(
      `${COLLECTOR_URL}/stats/chain${rangeQuery(days, Date.now(), periodsBack)}`,
      'collector chain',
    ),
  );
}
