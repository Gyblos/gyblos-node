// Owns the read of the metrics collector's public stats API (gyblos-node docs/metrics-collector.md,
// Public stats API): fetched, checked at the boundary and cached for the collector's 10-minute cycle.
import { cacheLife } from 'next/cache';
import { connection } from 'next/server';

import { COLLECTOR_URL } from './config';
import { CACHE_LIFE } from './constants';
import { fetchJson } from './fetch-json';
import type { Latency } from './latency';
import {
  flag,
  integerText,
  list,
  nullable,
  num,
  record,
  text,
  type JsonRecord,
} from './validate';

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
  // Paid only: usage both sides signed for, USDC atomic units.
  authorizedAtomic: string | null;
}
export type NetworkSide = Totals & {
  activeSellers: number;
  modelsServed: number;
  // null below the collector's public minimum.
  buyers: number | null;
  withheld: boolean;
};
export interface NetworkDay {
  day: string;
  free: NetworkSide | null;
  paid: NetworkSide | null;
  observed: {
    routes: { direct: number; relay: number; unknown: number };
  } | null;
  demand: { modelId: string; requests: number }[];
}
export type ModelSide = Totals & { sellers: number };
export interface ModelStat {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  free: ModelSide | null;
  paid: ModelSide | null;
}
export interface CollectorSnapshot {
  aggregatedAt: number | null;
  days: NetworkDay[];
  models: ModelStat[];
  error: string | null;
}

function latency(value: unknown, where: string): Latency {
  const source = record(value, where);
  return {
    samples: num(source.samples, `${where}.samples`),
    p50Ms: nullable(source.p50Ms, (present) => num(present, `${where}.p50Ms`)),
    p95Ms: nullable(source.p95Ms, (present) => num(present, `${where}.p95Ms`)),
    bucketsMs: list(source.bucketsMs, `${where}.bucketsMs`).map((edge) =>
      num(edge, where),
    ),
    counts: list(source.counts, `${where}.counts`).map((value) =>
      num(value, where),
    ),
  };
}
const counts = <K extends string>(
  value: unknown,
  keys: readonly K[],
  where: string,
) => {
  const source = record(value, where);
  return Object.fromEntries(
    keys.map((key) => [key, num(source[key], `${where}.${key}`)]),
  ) as Record<K, number>;
};
function totals(source: JsonRecord, where: string): Totals {
  const sellerLatency = record(source.sellerLatency, `${where}.sellerLatency`);
  return {
    requests: counts(
      source.requests,
      ['headline', 'bilateral', 'sellerOnly', 'disputed'],
      `${where}.requests`,
    ),
    outcomes: counts(
      source.outcomes,
      ['completed', 'failed', 'cancelled'],
      `${where}.outcomes`,
    ),
    successRate: nullable(source.successRate, (present) =>
      num(present, `${where}.successRate`),
    ),
    tokens: counts(
      source.tokens,
      ['input', 'output', 'reasoning', 'reasoningUnknown'],
      `${where}.tokens`,
    ),
    sellerLatency: {
      firstToken: latency(sellerLatency.firstToken, `${where}.firstToken`),
      total: latency(sellerLatency.total, `${where}.total`),
    },
    authorizedAtomic: nullable(source.authorizedAtomic, (present) =>
      integerText(present, `${where}.authorizedAtomic`),
    ),
  };
}
function networkSide(value: unknown, where: string): NetworkSide {
  const source = record(value, where);
  return {
    ...totals(source, where),
    activeSellers: num(source.activeSellers, `${where}.activeSellers`),
    modelsServed: num(source.modelsServed, `${where}.modelsServed`),
    buyers: nullable(source.buyers, (present) =>
      num(present, `${where}.buyers`),
    ),
    withheld: flag(source.withheld, `${where}.withheld`),
  };
}
export function parseNetworkDay(value: unknown): NetworkDay {
  const source = record(value, 'day');
  const observed = nullable(source.observed, (present) =>
    record(present, 'observed'),
  );
  return {
    day: text(source.day, 'day.day'),
    free: nullable(source.free, (present) => networkSide(present, 'free')),
    paid: nullable(source.paid, (present) => networkSide(present, 'paid')),
    observed: observed
      ? {
          routes: counts(
            observed.routes,
            ['direct', 'relay', 'unknown'],
            'routes',
          ),
        }
      : null,
    demand: list(source.demand, 'demand').map((entry) => {
      const model = counts(
        entry,
        ['unserved', 'refusedBeforeSelection', 'connectFailed'],
        'demand',
      );
      return {
        modelId: text(record(entry, 'demand').modelId, 'demand.modelId'),
        requests:
          model.unserved + model.refusedBeforeSelection + model.connectFailed,
      };
    }),
  };
}
function modelSide(value: unknown, where: string): ModelSide {
  const source = record(value, where);
  return {
    ...totals(source, where),
    sellers: num(source.sellers, `${where}.sellers`),
  };
}
export function parseModel(value: unknown): ModelStat {
  const source = record(value, 'model');
  const optional = (field: unknown, where: string) =>
    nullable(field, (present) => text(present, where));
  return {
    modelId: text(source.modelId, 'model.modelId'),
    variant: optional(source.variant, 'model.variant'),
    quantization: optional(source.quantization, 'model.quantization'),
    free: nullable(source.free, (present) => modelSide(present, 'model.free')),
    paid: nullable(source.paid, (present) => modelSide(present, 'model.paid')),
  };
}
const aggregatedAt = (source: JsonRecord) =>
  nullable(source.aggregatedAt, (present) => num(present, 'aggregatedAt')) ?? 0;

// The last 30 UTC days of network totals and models, as aggregated by the collector.
export async function getCollector(): Promise<CollectorSnapshot> {
  try {
    return await loadCollector();
  } catch (error) {
    // A failed read is never prerendered: it is retried on the next request.
    await connection();
    return {
      aggregatedAt: null,
      days: [],
      models: [],
      error: error instanceof Error ? error.message : 'collector unavailable',
    };
  }
}

// Throws on failure so an error is never stored in the cache.
async function loadCollector(): Promise<CollectorSnapshot> {
  'use cache';
  cacheLife(CACHE_LIFE.collector);
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
