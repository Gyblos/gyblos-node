// Owns the read of the metrics collector's public stats API and the merge of its latency histograms.
import { cacheLife } from 'next/cache';

import { COLLECTOR_URL } from './config';
import { CACHE_LIFE } from './constants';

// Shapes of the collector's public stats API (gyblos-node docs/metrics-collector.md, Public stats API).
export interface Latency {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  bucketsMs: number[];
  counts: number[];
}
export interface Totals {
  requests: {
    headline: number;
    bilateral: number;
    sellerOnly: number;
    disputed: number;
  };
  outcomes: { completed: number; failed: number; cancelled: number };
  successRate: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    reasoningUnknown: number;
  };
  sellerLatency: { firstToken: Latency; total: Latency };
  // Free only.
  backedByPayment?: false;
  // Paid only: usage both sides signed for, USDC atomic units.
  authorizedAtomic?: string;
  feeAtomic?: string;
}
export type NetworkSide = Totals & {
  conflicts: number;
  activeSellers: number;
  modelsServed: number;
  buyers: number | null;
  withheld: boolean;
};
export interface NetworkDay {
  day: string;
  free: NetworkSide | null;
  paid: NetworkSide | null;
  observed: {
    buyerLatency: { firstToken: Latency; total: Latency };
    routes: { direct: number; relay: number; unknown: number };
  } | null;
  demand: {
    modelId: string;
    unserved: number;
    refusedBeforeSelection: number;
    connectFailed: number;
  }[];
}
export interface ModelStat {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  free: (Totals & { sellers: number }) | null;
  paid: (Totals & { sellers: number }) | null;
}
interface Envelope {
  from: string;
  to: string;
  formulaVersion: number | null;
  aggregatedAt: number | null;
}
export interface CollectorSnapshot {
  aggregatedAt: number | null;
  days: NetworkDay[];
  models: ModelStat[];
  error: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${COLLECTOR_URL}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(`collector ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

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

// Throws on failure so an error is never stored in the cache. The collector recomputes every 10 min.
async function loadCollector(): Promise<CollectorSnapshot> {
  'use cache';
  cacheLife(CACHE_LIFE.collector);
  const [network, models] = await Promise.all([
    getJson<Envelope & { days: NetworkDay[] }>('/stats/network'),
    getJson<Envelope & { models: ModelStat[] }>('/stats/models'),
  ]);
  const aggregatedAt =
    Math.max(network.aggregatedAt ?? 0, models.aggregatedAt ?? 0) || null;
  return {
    aggregatedAt,
    days: network.days,
    models: models.models,
    error: null,
  };
}

// Sums histograms bucket by bucket and reads a percentile (upper bound of its bucket).
export function mergedLatency(
  parts: (Latency | undefined)[],
  share: number,
): number | null {
  const present = parts.filter(
    (part): part is Latency => !!part && part.samples > 0,
  );
  const first = present[0];
  if (!first) return null;
  const counts = first.counts.map((_, index) =>
    present.reduce((sum, part) => sum + (part.counts[index] ?? 0), 0),
  );
  const samples = counts.reduce((sum, value) => sum + value, 0);
  let seen = 0;
  for (const [index, value] of counts.entries()) {
    seen += value;
    if (seen >= samples * share) return first.bucketsMs[index] ?? null;
  }
  return null;
}
