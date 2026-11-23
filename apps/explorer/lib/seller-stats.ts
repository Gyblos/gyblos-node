import { cache } from 'react';

import {
  parseSellerStats,
  type ModelStat,
  type SellerDay,
} from './collector-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';
import { rangeQuery, type RangeDays } from './range';

export interface SellerStats {
  aggregatedAt: number | null;
  days: SellerDay[];
  models: ModelStat[];
  error: string | null;
}

export const getSellerStats = cache(
  async (nodeId: string, days: RangeDays): Promise<SellerStats> => {
    try {
      const body = await fetchJson(
        `${COLLECTOR_URL}/stats/sellers/${nodeId}${rangeQuery(days, Date.now())}`,
        'collector seller',
      );
      return { ...parseSellerStats(body), error: null };
    } catch (error) {
      return {
        aggregatedAt: null,
        days: [],
        models: [],
        error: error instanceof Error ? error.message : 'seller unavailable',
      };
    }
  },
);
