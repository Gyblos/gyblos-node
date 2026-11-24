// Owns the public stats routes: parse the day range (and NodeId), call the stats use case, answer it
// cacheable. Bad input answers 400 INVALID_QUERY; no read port answers 503 COLLECTOR_UNAVAILABLE.
import type { Context, Hono } from 'hono';

import {
  AGGREGATES,
  COLLECTOR_ERRORS,
  COLLECTOR_HEADER_VALUES,
  COLLECTOR_HEADERS,
  COLLECTOR_ROUTES,
  COLLECTOR_STATUS,
} from './constants';
import { dayBounds, dayOfTime, dayRange, type DayRange } from './days';
import { rejection } from './http';
import {
  modelStats,
  networkStats,
  sellerStats,
  type StatsEnvelope,
} from './stats';
import { chainStats } from './stats-chain';
import {
  chainTransactions,
  parseChainTxQuery,
  type ChainTxReader,
} from './stats-chain-txs';
import type { StatsReader, StatsResource } from './stats-store';

const NODE_ID = /^[0-9a-f]{64}$/;

async function requestedRange(
  context: Context,
  reader: StatsReader,
  resource: StatsResource,
  now: number,
): Promise<DayRange | undefined> {
  const nodeId = context.req.param('nodeId') ?? '';
  if (resource === COLLECTOR_ROUTES.STATS_SELLER && !NODE_ID.test(nodeId))
    return undefined;
  const mode = context.req.queries('range');
  const from = context.req.query('from');
  const to = context.req.query('to');
  if (!mode) return dayRange(from, to, now);
  const today = dayOfTime(now);
  const end = dayBounds(to ?? today);
  if (
    mode.length !== 1 ||
    mode[0] !== AGGREGATES.allTimeRange ||
    from !== undefined ||
    (context.req.queries('to')?.length ?? 0) > 1 ||
    !end ||
    end.day > today
  )
    return undefined;
  const first = await reader.firstDay(resource, end.day, nodeId);
  return {
    from: first ?? end.day,
    to: end.day,
    range: AGGREGATES.allTimeRange,
    historyAvailable: first !== null,
  };
}

export function statsRoutes(
  app: Hono,
  reader: StatsReader | undefined,
  now: () => number,
  chainTxs?: ChainTxReader,
) {
  function register<Answer extends StatsEnvelope>(
    resource: StatsResource,
    answer: (
      reader: StatsReader,
      range: DayRange,
      context: Context,
    ) => Promise<Answer>,
  ) {
    app.get(resource, async (context) => {
      if (!reader) return rejection(context, COLLECTOR_ERRORS.UNAVAILABLE);
      const range = await requestedRange(context, reader, resource, now());
      if (!range) return rejection(context, COLLECTOR_ERRORS.INVALID_QUERY);
      const body = await answer(reader, range, context);
      context.header(
        COLLECTOR_HEADERS.CACHE_CONTROL,
        COLLECTOR_HEADER_VALUES.PUBLIC_STATS,
      );
      return context.json(body, COLLECTOR_STATUS.OK);
    });
  }
  register(COLLECTOR_ROUTES.STATS_NETWORK, (stats, range) =>
    networkStats(stats, range, dayOfTime(now())),
  );
  register(COLLECTOR_ROUTES.STATS_MODELS, modelStats);
  register(COLLECTOR_ROUTES.STATS_CHAIN, chainStats);
  register(COLLECTOR_ROUTES.STATS_SELLER, (stats, range, context) =>
    sellerStats(stats, context.req.param('nodeId') ?? '', range),
  );
  app.get(COLLECTOR_ROUTES.STATS_CHAIN_TXS, async (context) => {
    if (!chainTxs) return rejection(context, COLLECTOR_ERRORS.UNAVAILABLE);
    const url = new URL(context.req.url);
    const query = parseChainTxQuery(url.searchParams);
    if (!query || url.search.slice(1) !== url.searchParams.toString())
      return rejection(context, COLLECTOR_ERRORS.INVALID_QUERY);
    const body = await chainTransactions(chainTxs, query);
    context.header(
      COLLECTOR_HEADERS.CACHE_CONTROL,
      COLLECTOR_HEADER_VALUES.PUBLIC_STATS,
    );
    return context.json(body, COLLECTOR_STATUS.OK);
  });
}
