import { cache } from 'react';

import {
  parseSellerStats,
  type ModelStat,
  type SellerDay,
} from './collector-shape';
import { rangeEnd, type RangeDays } from './range';
import { readStats } from './stats-window';

export interface SellerStats {
  aggregatedAt: number | null;
  days: SellerDay[];
  models: ModelStat[];
  error: string | null;
}

export const getSellerStats = cache(
  async (
    nodeId: string,
    days: RangeDays,
    closed = true,
  ): Promise<SellerStats> => {
    try {
      const body = await readStats(
        `sellers/${encodeURIComponent(nodeId)}`,
        days,
        rangeEnd(days, Date.now(), closed),
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
