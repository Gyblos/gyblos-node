// Owns the shape of the metrics collector's public stats answers (gyblos-node docs/metrics-collector.md,
// Public stats API) and their checks at the boundary. Pure, no I/O.
import type { Latency } from './latency';
import {
  flag,
  integerText,
  list,
  nullable,
  num,
  record,
  SourceShapeError,
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
export type SellerSide = Totals & BuyerCount;
export interface SellerDay {
  day: string;
  free: SellerSide | null;
  paid: SellerSide | null;
}
export const COVERAGE_STATES = [
  'final',
  'partial',
  'pending',
  'unknown',
] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];
export interface NetworkDay {
  day: string;
  coverage: CoverageState | null;
  free: NetworkSide | null;
  paid: NetworkSide | null;
  observed: {
    routes: { direct: number; relay: number; unknown: number };
  } | null;
  demand: { modelId: string; requests: number }[];
}
// Output tokens per second of generation, from engines that report their generation time: the lower
// bound of the bucket holding the median, null without samples. The explorer reads the median only.
export interface Speed {
  samples: number;
  p50MinTokensPerSecond: number | null;
}
// Per-model observations joined to their receipts: the first token as the buyer saw it (streaming
// requests only) and the engine's generation speed.
export interface ModelObserved {
  buyerFirstToken: Latency;
  engineSpeed: Speed;
}
export type ModelSide = Totals & {
  // null without any observation joined to a receipt on that side: no data, never zero.
  observed: ModelObserved | null;
};
export interface ModelStat {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  free: ModelSide | null;
  paid: ModelSide | null;
}
export type BuyerCount = Pick<NetworkSide, 'buyers' | 'withheld'>;
export interface BuyerTotals {
  allTime: BuyerCount;
  newInRange: BuyerCount;
}
export interface NetworkBuyers {
  free: BuyerTotals;
  paid: BuyerTotals;
}
export interface CollectorSnapshot {
  aggregatedAt: number | null;
  days: NetworkDay[];
  models: ModelStat[];
  buyerTotals: NetworkBuyers | null;
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
function speed(value: unknown, where: string): Speed {
  const source = record(value, where);
  return {
    samples: num(source.samples, `${where}.samples`),
    p50MinTokensPerSecond: nullable(source.p50MinTokensPerSecond, (present) =>
      num(present, `${where}.p50MinTokensPerSecond`),
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
function sellerSide(value: unknown, where: string): SellerSide {
  const source = record(value, where);
  return {
    ...totals(source, where),
    buyers: nullable(source.buyers, (present) =>
      num(present, `${where}.buyers`),
    ),
    withheld: flag(source.withheld, `${where}.withheld`),
  };
}
function buyerCount(value: unknown, where: string): BuyerCount {
  const source = record(value, where);
  const withheld = flag(source.withheld, `${where}.withheld`);
  const buyers = nullable(source.buyers, (present) =>
    num(present, `${where}.buyers`),
  );
  if (withheld !== (buyers === null)) throw new SourceShapeError(where);
  return { buyers, withheld };
}
function buyerTotals(value: unknown, where: string): BuyerTotals {
  const source = record(value, where);
  return {
    allTime: buyerCount(source.allTime, `${where}.allTime`),
    newInRange: buyerCount(source.newInRange, `${where}.newInRange`),
  };
}
export function parseNetworkBuyers(value: unknown): NetworkBuyers | null {
  return nullable(value, (present) => {
    const source = record(present, 'buyerTotals');
    return {
      free: buyerTotals(source.free, 'buyerTotals.free'),
      paid: buyerTotals(source.paid, 'buyerTotals.paid'),
    };
  });
}
export function optionalNetworkBuyers(value: unknown): NetworkBuyers | null {
  try {
    return parseNetworkBuyers(value);
  } catch (error) {
    if (error instanceof SourceShapeError) return null;
    throw error;
  }
}
function networkSide(value: unknown, where: string): NetworkSide {
  const source = record(value, where);
  return {
    ...sellerSide(source, where),
    activeSellers: num(source.activeSellers, `${where}.activeSellers`),
    modelsServed: num(source.modelsServed, `${where}.modelsServed`),
  };
}
function coverageState(value: unknown): CoverageState | null {
  if (value === undefined) return null;
  const state = text(record(value, 'coverage').state, 'coverage.state');
  const known = COVERAGE_STATES.find((option) => option === state);
  if (!known) throw new SourceShapeError('coverage.state');
  return known;
}
export function parseNetworkDay(value: unknown): NetworkDay {
  const source = record(value, 'day');
  const observed = nullable(source.observed, (present) =>
    record(present, 'observed'),
  );
  return {
    day: text(source.day, 'day.day'),
    coverage: coverageState(source.coverage),
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
    observed: nullable(source.observed, (present) => {
      const at = `${where}.observed`;
      const observed = record(present, at);
      return {
        buyerFirstToken: latency(
          observed.buyerFirstToken,
          `${at}.buyerFirstToken`,
        ),
        engineSpeed: speed(observed.engineSpeed, `${at}.engineSpeed`),
      };
    }),
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
export const aggregatedAt = (source: JsonRecord) =>
  nullable(source.aggregatedAt, (present) => num(present, 'aggregatedAt')) ?? 0;

function sellerDay(value: unknown): SellerDay {
  const source = record(value, 'seller.day');
  return {
    day: text(source.day, 'seller.day.day'),
    free: nullable(source.free, (present) => sellerSide(present, 'free')),
    paid: nullable(source.paid, (present) => sellerSide(present, 'paid')),
  };
}
export function parseSellerStats(value: unknown) {
  const source = record(value, 'seller');
  return {
    aggregatedAt: aggregatedAt(source) || null,
    days: list(source.days, 'seller.days').map(sellerDay),
    models: list(source.models, 'seller.models').map(parseModel),
  };
}
