// Owns the read of the metrics collector's public stats API: fetched, checked at the boundary
// (collector-shape.ts) on each render; the collector caches its answers at the edge.

import { cache } from 'react';

import {
  aggregatedAt,
  optionalNetworkBuyers,
  parseModel,
  parseNetworkDay,
  type CollectorSnapshot,
} from './collector-shape';
import { rangeEnd, type RangeDays } from './range';
import { readStats } from './stats-window';
import { list, text } from './validate';

export type {
  CollectorSnapshot,
  NetworkBuyers,
  NetworkDay,
  NetworkSide,
  Totals,
} from './collector-shape';

// The last `days` UTC days of network totals and models, as aggregated by the collector, or the
// span just before them with `periodsBack` 1. Read once per render and span: the Models and Usage
// sections share the answer.
export const getCollector = (
  days: RangeDays,
  periodsBack = 0,
  closed = false,
) => readCollector(days, periodsBack, closed);
// Memoized on both arguments always passed, so a default and an explicit 0 share one read.
const readCollector = cache(
  async (
    days: RangeDays,
    periodsBack: number,
    closed: boolean,
  ): Promise<CollectorSnapshot> => {
    try {
      return await loadCollector(
        days,
        rangeEnd(days, Date.now(), closed),
        periodsBack,
      );
    } catch (error) {
      return {
        aggregatedAt: null,
        days: [],
        models: [],
        buyerTotals: null,
        error: error instanceof Error ? error.message : 'collector unavailable',
      };
    }
  },
);

async function loadCollector(
  days: RangeDays,
  end: number,
  periodsBack: number,
): Promise<CollectorSnapshot> {
  const [network, models] = await Promise.all([
    readStats('network', days, end, periodsBack),
    readStats('models', days, end, periodsBack),
  ]);
  return {
    error: null,
    aggregatedAt: Math.max(aggregatedAt(network), aggregatedAt(models)) || null,
    days: list(network.days, 'network.days').map(parseNetworkDay),
    models: list(models.models, 'models.models').map(parseModel),
    buyerTotals: optionalNetworkBuyers(network.buyerTotals),
  };
}

export async function getOverviewNetwork(
  days: RangeDays,
  now: number,
  periodsBack = 0,
) {
  try {
    const source = await readStats(
      'network',
      days,
      rangeEnd(days, now, true),
      periodsBack,
    );
    return {
      from: text(source.from, 'network.from'),
      to: text(source.to, 'network.to'),
      days: list(source.days, 'network.days').map(parseNetworkDay),
      version:
        typeof source.formulaVersion === 'number'
          ? source.formulaVersion
          : null,
      updated: aggregatedAt(source),
    };
  } catch {
    return null;
  }
}
