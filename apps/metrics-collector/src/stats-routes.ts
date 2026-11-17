// Owns the public stats routes: parse the day range (and NodeId), call the stats use case, answer it
// cacheable. Bad input answers 400 INVALID_QUERY; no read port answers 503 COLLECTOR_UNAVAILABLE.
import type { Context, Hono } from 'hono';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_HEADER_VALUES,
  COLLECTOR_HEADERS,
  COLLECTOR_ROUTES,
  COLLECTOR_STATUS,
} from './constants';
import { dayRange, type DayRange } from './days';
import { rejection } from './http';
import {
  modelStats,
  networkStats,
  sellerStats,
  type StatsEnvelope,
} from './stats';
import { chainStats } from './stats-chain';
import type { StatsReader } from './stats-store';

const NODE_ID = /^[0-9a-f]{64}$/;

export function statsRoutes(
  app: Hono,
  reader: StatsReader | undefined,
  now: () => number,
) {
  const handle =
    <Answer extends StatsEnvelope>(
      answer: (
        reader: StatsReader,
        range: DayRange,
        context: Context,
      ) => Promise<Answer> | undefined,
    ) =>
    async (context: Context) => {
      if (!reader) return rejection(context, COLLECTOR_ERRORS.UNAVAILABLE);
      const range = dayRange(
        context.req.query('from'),
        context.req.query('to'),
        now(),
      );
      const body = range && (await answer(reader, range, context));
      if (!body) return rejection(context, COLLECTOR_ERRORS.INVALID_QUERY);
      context.header(
        COLLECTOR_HEADERS.CACHE_CONTROL,
        COLLECTOR_HEADER_VALUES.PUBLIC_STATS,
      );
      return context.json(body, COLLECTOR_STATUS.OK);
    };
  app.get(COLLECTOR_ROUTES.STATS_NETWORK, handle(networkStats));
  app.get(COLLECTOR_ROUTES.STATS_MODELS, handle(modelStats));
  app.get(COLLECTOR_ROUTES.STATS_CHAIN, handle(chainStats));
  app.get(
    COLLECTOR_ROUTES.STATS_SELLER,
    handle((stats, range, context) => {
      const nodeId = context.req.param('nodeId') ?? '';
      return NODE_ID.test(nodeId)
        ? sellerStats(stats, nodeId, range)
        : undefined;
    }),
  );
}
