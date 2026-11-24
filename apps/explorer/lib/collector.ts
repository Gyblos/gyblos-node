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
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';
import { rangeQuery, type RangeDays } from './range';
import { list, record } from './validate';

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
export const getCollector = (days: RangeDays, periodsBack = 0) =>
  readCollector(days, periodsBack);
// Memoized on both arguments always passed, so a default and an explicit 0 share one read.
const readCollector = cache(
  async (days: RangeDays, periodsBack: number): Promise<CollectorSnapshot> => {
    try {
      return await loadCollector(rangeQuery(days, Date.now(), periodsBack));
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

async function loadCollector(query: string): Promise<CollectorSnapshot> {
  const [networkBody, modelsBody] = await Promise.all([
    fetchJson(`${COLLECTOR_URL}/stats/network${query}`, 'collector network'),
    fetchJson(`${COLLECTOR_URL}/stats/models${query}`, 'collector models'),
  ]);
  const network = record(networkBody, 'network');
  const models = record(modelsBody, 'models');
  return {
    aggregatedAt: Math.max(aggregatedAt(network), aggregatedAt(models)) || null,
    days: list(network.days, 'network.days').map(parseNetworkDay),
    models: list(models.models, 'models.models').map(parseModel),
    buyerTotals: optionalNetworkBuyers(network.buyerTotals),
    error: null,
  };
}

export async function overviewNetwork(dates: string[]) {
  const from = dates[0];
  const to = dates.at(-1);
  try {
    const source = record(
      await fetchJson(
        `${COLLECTOR_URL}/stats/network?from=${from}&to=${to}`,
        'collector network',
      ),
      'network',
    );
    if (source.from !== from || source.to !== to) return null;
    return {
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
