// Owns the public read API: GET /v1/stats/network, /v1/stats/models and /v1/stats/sellers/:nodeId.
// Aggregates only, never a receipt, buyer identity or observation. Day ranges are UTC, inclusive,
// at most AGGREGATES.maxRangeDays, defaulting to the last AGGREGATES.defaultRangeDays days.
import type { Context, Hono } from 'hono';

import { dayBounds } from './aggregate-sql';
import {
  AGGREGATES,
  COLLECTOR_ERRORS,
  COLLECTOR_HEADER_VALUES,
  COLLECTOR_HEADERS,
  COLLECTOR_ROUTES,
  COLLECTOR_STATUS,
} from './constants';
import { statusOf } from './errors';
import type { DayRange, StatsReader } from './stats-read';
import {
  bySide,
  daysOf,
  latency,
  nullable,
  publicBuyers,
  totalsSection,
  type TotalsFields,
} from './stats-shape';

const NODE_ID = /^[0-9a-f]{64}$/;
const today = (now: number) => new Date(now).toISOString().split('T')[0]!;

// The requested range, or undefined when malformed, reversed or too long.
export function dayRange(
  from: string | undefined,
  to: string | undefined,
  now: number,
): DayRange | undefined {
  const end = dayBounds(to ?? today(now));
  if (!end) return undefined;
  const start = dayBounds(
    from ??
      today(end.start - (AGGREGATES.defaultRangeDays - 1) * AGGREGATES.dayMs),
  );
  if (!start || start.start > end.start) return undefined;
  if ((end.start - start.start) / AGGREGATES.dayMs >= AGGREGATES.maxRangeDays)
    return undefined;
  return { from: start.day, to: end.day };
}

const latest = (rows: readonly { aggregatedAt: number | null }[]) =>
  rows.reduce<number | null>(
    (max, row) =>
      row.aggregatedAt !== null && (max === null || row.aggregatedAt > max)
        ? row.aggregatedAt
        : max,
    null,
  );
const envelope = (range: DayRange, aggregatedAt: number | null) => ({
  ...range,
  formulaVersion: AGGREGATES.formulaVersion,
  // When the newest row in the answer was computed; null when the range has no data.
  aggregatedAt,
});

async function network(reader: StatsReader, range: DayRange) {
  const { network, observed, demand } = await reader.network(range);
  const days = daysOf(range).map((day) => {
    const sides = bySide(
      network.filter((row) => row.day === day),
      (row) => ({
        ...totalsSection(row),
        conflicts: row.conflicts,
        activeSellers: row.activeSellers,
        // Free buyers are distinct NodeIds, paid buyers distinct wallets: never add them up.
        buyers: row.buyers,
        modelsServed: row.modelsServed,
      }),
    );
    const seen = observed.find((row) => row.day === day);
    const wanted = demand.filter((row) => row.day === day);
    return {
      day,
      ...sides,
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
      demand: wanted.map((row) => ({
        modelId: row.modelId,
        unserved: row.unserved,
        refusedBeforeSelection: row.refusedBeforeSelection,
        connectFailed: row.connectFailed,
      })),
    };
  });
  return {
    ...envelope(range, latest([...network, ...observed, ...demand])),
    days,
  };
}

type ModelRow = TotalsFields & {
  modelId: string;
  variant: string;
  quantization: string;
  aggregatedAt: number | null;
};
// Joins free and paid rows of the same model into one entry, keeping the first-seen order.
function modelEntries<T extends ModelRow>(
  rows: readonly T[],
  extra: (row: T) => object,
) {
  const entries = new Map<string, T[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.modelId, row.variant, row.quantization]);
    entries.set(key, [...(entries.get(key) ?? []), row]);
  }
  return [...entries.values()].map((group) => ({
    modelId: group[0]!.modelId,
    variant: nullable(group[0]!.variant),
    quantization: nullable(group[0]!.quantization),
    ...bySide(group, (row) => ({ ...totalsSection(row), ...extra(row) })),
  }));
}

async function models(reader: StatsReader, range: DayRange) {
  const rows = await reader.models(range);
  return {
    ...envelope(range, latest(rows)),
    models: modelEntries(rows, (row) => ({ sellers: row.sellers })),
  };
}

async function seller(reader: StatsReader, nodeId: string, range: DayRange) {
  const { days, models, buyers } = await reader.seller(nodeId, range);
  const count = (day: string, paid: number) =>
    buyers.find((row) => row.day === day && row.paid === paid)?.buyers;
  return {
    nodeId,
    ...envelope(range, latest([...days, ...models])),
    days: daysOf(range).map((day) => ({
      day,
      ...bySide(
        days.filter((row) => row.day === day),
        (row) => ({
          ...totalsSection(row),
          ...publicBuyers(count(day, row.paid)),
        }),
      ),
    })),
    models: modelEntries(models, () => ({})),
  };
}

function reject(
  context: Context,
  code: (typeof COLLECTOR_ERRORS)[keyof typeof COLLECTOR_ERRORS],
) {
  return context.json({ error: code }, statusOf(code));
}
function cached(context: Context, body: object) {
  context.header(
    COLLECTOR_HEADERS.CACHE_CONTROL,
    COLLECTOR_HEADER_VALUES.PUBLIC_STATS,
  );
  return context.json(body, COLLECTOR_STATUS.OK);
}

export function statsRoutes(
  app: Hono,
  reader: StatsReader | undefined,
  now: () => number,
) {
  const handle =
    (
      answer: (
        reader: StatsReader,
        range: DayRange,
        context: Context,
      ) => Promise<object> | undefined,
    ) =>
    async (context: Context) => {
      if (!reader) return reject(context, COLLECTOR_ERRORS.UNAVAILABLE);
      const range = dayRange(
        context.req.query('from'),
        context.req.query('to'),
        now(),
      );
      if (!range) return reject(context, COLLECTOR_ERRORS.INVALID_QUERY);
      const body = await answer(reader, range, context);
      return body
        ? cached(context, body)
        : reject(context, COLLECTOR_ERRORS.INVALID_QUERY);
    };
  app.get(COLLECTOR_ROUTES.STATS_NETWORK, handle(network));
  app.get(COLLECTOR_ROUTES.STATS_MODELS, handle(models));
  app.get(
    COLLECTOR_ROUTES.STATS_SELLER,
    handle((stats, range, context) => {
      const nodeId = context.req.param('nodeId') ?? '';
      return NODE_ID.test(nodeId) ? seller(stats, nodeId, range) : undefined;
    }),
  );
}
