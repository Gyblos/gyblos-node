// Owns the public stats use case: turns aggregate rows from the read port into the typed answers of
// GET /v1/stats/network, /v1/stats/models and /v1/stats/sellers/:nodeId (docs/metrics-collector.md).
// Aggregates only: never a receipt, a buyer identity or a raw observation.
import { daysOf, type DayRange } from './days';
import {
  failureEntry,
  originEntry,
  type FailureEntry,
  type OriginEntry,
} from './stats-breakdowns';
import {
  bySide,
  latency,
  nullable,
  publicBuyers,
  type FreeSection,
  type Latency,
  type PaidSection,
  type PublicBuyers,
} from './stats-shape';
import type {
  ModelRow,
  SellerModelRow,
  StatsReader,
  TotalsRow,
} from './stats-store';

export interface StatsEnvelope extends DayRange {
  // The formula version of every row in the answer, or null when the range has no data or rows
  // still differ (a recompute after a formula change is under way).
  formulaVersion: number | null;
  // When the newest row in the answer was computed; null when the range has no data.
  aggregatedAt: number | null;
}
type Sides<F, P> = {
  free: (FreeSection & F) | null;
  paid: (PaidSection & P) | null;
};
type NetworkSide = {
  conflicts: number;
  activeSellers: number;
  modelsServed: number;
} & PublicBuyers;
export interface NetworkDay extends Sides<NetworkSide, NetworkSide> {
  day: string;
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
  // Requests by the buyer application that reported them; failures by side, application and reason.
  origins: OriginEntry[];
  failures: FailureEntry[];
}
export interface ModelEntry<F = object, P = object> extends Sides<F, P> {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}
export interface NetworkStats extends StatsEnvelope {
  days: NetworkDay[];
}
export interface ModelStats extends StatsEnvelope {
  models: ModelEntry<{ sellers: number }, { sellers: number }>[];
}
export interface SellerStats extends StatsEnvelope {
  nodeId: string;
  days: ({ day: string } & Sides<PublicBuyers, PublicBuyers>)[];
  models: ModelEntry[];
}

// What the answer's envelope needs from any row: when it was computed and with which formula
// versions (one version for a plain aggregate row, a min/max pair for grouped totals).
interface Computed {
  aggregatedAt: number | null;
  minVersion: number | null;
  maxVersion: number | null;
}
const fromTotals = (row: TotalsRow): Computed => ({
  aggregatedAt: row.aggregatedAt,
  minVersion: row.minFormulaVersion,
  maxVersion: row.maxFormulaVersion,
});
export const fromRow = (row: {
  aggregatedAt: number;
  formulaVersion: number;
}): Computed => ({
  aggregatedAt: row.aggregatedAt,
  minVersion: row.formulaVersion,
  maxVersion: row.formulaVersion,
});

export function envelope(
  range: DayRange,
  rows: readonly Computed[],
): StatsEnvelope {
  let aggregatedAt: number | null = null;
  const versions = new Set<number | null>();
  for (const row of rows) {
    if (
      row.aggregatedAt !== null &&
      (aggregatedAt === null || row.aggregatedAt > aggregatedAt)
    )
      aggregatedAt = row.aggregatedAt;
    versions.add(row.minVersion);
    versions.add(row.maxVersion);
  }
  const [only] = versions;
  return {
    ...range,
    formulaVersion: versions.size === 1 && only !== undefined ? only : null,
    aggregatedAt,
  };
}

// Groups rows by a key once, so per-day assembly is linear in the rows.
export function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows)
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

export async function networkStats(
  reader: StatsReader,
  range: DayRange,
): Promise<NetworkStats> {
  const { network, observed, demand, origins, failures } =
    await reader.network(range);
  const originsByDay = groupBy(origins, (row) => row.day);
  const failuresByDay = groupBy(failures, (row) => row.day);
  const networkByDay = groupBy(network, (row) => row.day);
  const observedByDay = new Map(observed.map((row) => [row.day, row]));
  const demandByDay = groupBy(demand, (row) => row.day);
  const days = daysOf(range).map((day): NetworkDay => {
    const seen = observedByDay.get(day);
    return {
      day,
      ...bySide(networkByDay.get(day) ?? [], (row) => ({
        conflicts: row.conflicts,
        activeSellers: row.activeSellers,
        modelsServed: row.modelsServed,
        // Free buyers are distinct NodeIds, paid buyers distinct wallets: never add them up.
        ...publicBuyers(row.buyers),
      })),
      observed: seen
        ? {
            buyerLatency: {
              firstToken: latency(seen.buyerFirstTokenHist),
              total: latency(seen.buyerTotalHist),
            },
            routes: {
              direct: seen.routeDirect,
              relay: seen.routeRelay,
              unknown: seen.routeUnknown,
            },
          }
        : null,
      demand: (demandByDay.get(day) ?? []).map((row) => ({
        modelId: row.modelId,
        unserved: row.unserved,
        refusedBeforeSelection: row.refusedBeforeSelection,
        connectFailed: row.connectFailed,
      })),
      origins: (originsByDay.get(day) ?? []).map(originEntry),
      failures: (failuresByDay.get(day) ?? []).map(failureEntry),
    };
  });
  return {
    ...envelope(range, [
      ...network.map(fromTotals),
      ...observed.map(fromRow),
      ...demand.map(fromRow),
      ...origins.map(fromRow),
      ...failures.map(fromRow),
    ]),
    days,
  };
}

// Joins the free and paid rows of each model, keeping the reader's order (most completed first).
function modelEntries<T extends ModelRow | SellerModelRow, E extends object>(
  rows: readonly T[],
  extra: (row: T) => E,
): ModelEntry<E, E>[] {
  const groups = groupBy(rows, (row) =>
    JSON.stringify([row.modelId, row.variant, row.quantization]),
  );
  return [...groups.values()].map((group) => ({
    modelId: group[0]!.modelId,
    variant: nullable(group[0]!.variant),
    quantization: nullable(group[0]!.quantization),
    ...bySide(group, extra),
  }));
}

export async function modelStats(
  reader: StatsReader,
  range: DayRange,
): Promise<ModelStats> {
  const rows = await reader.models(range);
  return {
    ...envelope(range, rows.map(fromTotals)),
    models: modelEntries(rows, (row) => ({ sellers: row.sellers })),
  };
}

export async function sellerStats(
  reader: StatsReader,
  nodeId: string,
  range: DayRange,
): Promise<SellerStats> {
  const { days, models, buyers } = await reader.seller(nodeId, range);
  const daysByDay = groupBy(days, (row) => row.day);
  const buyersOf = new Map(
    buyers.map((row) => [`${row.day}/${row.paid}`, row.buyers]),
  );
  return {
    nodeId,
    ...envelope(range, [...days, ...models].map(fromTotals)),
    days: daysOf(range).map((day) => ({
      day,
      ...bySide(daysByDay.get(day) ?? [], (row) =>
        publicBuyers(buyersOf.get(`${day}/${row.paid}`)),
      ),
    })),
    models: modelEntries(models, () => ({})),
  };
}
