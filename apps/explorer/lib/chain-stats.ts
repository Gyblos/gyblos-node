// Owns the read of the collector's chain stats (GET /v1/stats/chain): the collector indexes the
// payment-channels program and aggregates it per day, so the explorer reads no RPC itself. Fetched,
// checked at the boundary (chain-shape.ts) on each render; the collector caches it at the edge.

import { parseChainStats, type ChainSnapshot } from './chain-shape';
import { rangeEnd, type RangeDays } from './range';
import { readStats } from './stats-window';

export type { ChainSnapshot } from './chain-shape';

// `periodsBack` 1 reads the span of the same length just before the range, for a change.
export async function getChainStats(
  days: RangeDays,
  periodsBack = 0,
  closed = false,
  now = Date.now(),
): Promise<ChainSnapshot> {
  try {
    return {
      ...(await loadChainStats(days, periodsBack, rangeEnd(days, now, closed))),
      error: null,
    };
  } catch (error) {
    return {
      aggregatedAt: null,
      backfillDone: null,
      days: [],
      error: error instanceof Error ? error.message : 'chain stats unavailable',
    };
  }
}

async function loadChainStats(
  days: RangeDays,
  periodsBack: number,
  now: number,
) {
  return parseChainStats(await readStats('chain', days, now, periodsBack));
}
