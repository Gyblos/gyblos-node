// Owns the read of the metrics collector's public stats API: fetched, checked at the boundary
// (collector-shape.ts) on each render; the collector caches its answers at the edge.

import {
  aggregatedAt,
  parseModel,
  parseNetworkDay,
  type CollectorSnapshot,
} from './collector-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';
import { list, record } from './validate';

export type {
  CollectorSnapshot,
  ModelSide,
  ModelStat,
  NetworkDay,
  NetworkSide,
  Totals,
} from './collector-shape';

// The last 30 UTC days of network totals and models, as aggregated by the collector.
export async function getCollector(): Promise<CollectorSnapshot> {
  try {
    return await loadCollector();
  } catch (error) {
    return {
      aggregatedAt: null,
      days: [],
      models: [],
      error: error instanceof Error ? error.message : 'collector unavailable',
    };
  }
}

async function loadCollector(): Promise<CollectorSnapshot> {
  const [networkBody, modelsBody] = await Promise.all([
    fetchJson(`${COLLECTOR_URL}/stats/network`, 'collector network'),
    fetchJson(`${COLLECTOR_URL}/stats/models`, 'collector models'),
  ]);
  const network = record(networkBody, 'network');
  const models = record(modelsBody, 'models');
  return {
    aggregatedAt: Math.max(aggregatedAt(network), aggregatedAt(models)) || null,
    days: list(network.days, 'network.days').map(parseNetworkDay),
    models: list(models.models, 'models.models').map(parseModel),
    error: null,
  };
}
