// Owns the metrics collector HTTP app: signed receipt uploads from sellers and buyers. It never stores
// or logs IPs, never publishes individual receipts and answers only static error codes.
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_HEADER_VALUES,
  COLLECTOR_HEADERS,
  COLLECTOR_INTERNAL_ERROR,
  COLLECTOR_LIMITERS,
  COLLECTOR_LIMITS,
  COLLECTOR_PROTOCOLS,
  COLLECTOR_ROUTES,
  COLLECTOR_STATUS,
  GLOBAL_LIMIT_KEY,
  LOOPBACK_HOSTS,
  type CollectorErrorCode,
  type CollectorLimiterName,
} from './constants';
import { CollectorError, statusOf } from './errors';
import { rejection } from './http';
import { ingestUpload, StaleUploadError } from './ingest';
import { ingestObservations } from './ingest-observations';
import { ipKey } from './ip-key';
import { statsRoutes } from './stats-routes';
import type { StatsReader } from './stats-store';
import type { CollectorStorage } from './storage';

// The subset of a Cloudflare rate-limit binding the collector uses.
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export type CollectorLimiters = Partial<
  Record<CollectorLimiterName, RateLimiter>
>;

export interface MetricsCollectorOptions {
  // Missing storage or any missing limiter fails closed with 503 COLLECTOR_UNAVAILABLE.
  storage?: CollectorStorage;
  limiters?: CollectorLimiters;
  // Public aggregate reads; missing answers 503 COLLECTOR_UNAVAILABLE on the stats routes only.
  stats?: StatsReader;
  now?: () => number;
  // Loopback hosts only: plain http is accepted. Storage and limiters are never relaxed.
  development?: boolean;
  // The operator's RPC probe (rpc-probe.ts): its answer, or undefined for the usual 404.
  probe?: (request: Request) => Promise<Response | undefined>;
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

function secureRequest(url: string, development: boolean) {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === COLLECTOR_PROTOCOLS.SECURE ||
    (development &&
      protocol === COLLECTOR_PROTOCOLS.LOOPBACK &&
      LOOPBACK_HOSTS.has(hostname))
  );
}

async function allowed(limiter: RateLimiter, key: string) {
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return false;
  }
}

// Nothing is cacheable unless a route said so (only successful public stats do).
function finishHeaders(context: Context) {
  const headers = context.res.headers;
  if (
    context.res.status !== COLLECTOR_STATUS.OK ||
    !headers.has(COLLECTOR_HEADERS.CACHE_CONTROL)
  )
    headers.set(
      COLLECTOR_HEADERS.CACHE_CONTROL,
      COLLECTOR_HEADER_VALUES.NO_STORE,
    );
  headers.set(COLLECTOR_HEADERS.ROBOTS, COLLECTOR_HEADER_VALUES.NOINDEX);
  headers.set(
    COLLECTOR_HEADERS.CONTENT_TYPE_OPTIONS,
    COLLECTOR_HEADER_VALUES.NOSNIFF,
  );
}

function resolve(options: MetricsCollectorOptions) {
  const limiters = options.limiters ?? {};
  const ip = limiters[COLLECTOR_LIMITERS.IP];
  const node = limiters[COLLECTOR_LIMITERS.NODE];
  const global = limiters[COLLECTOR_LIMITERS.GLOBAL];
  const read = limiters[COLLECTOR_LIMITERS.READ];
  if (!options.storage || !ip || !node || !global || !read) return null;
  return { storage: options.storage, ip, node, global, read };
}

// The operator's RPC probe, behind the same https check, limits and headers as every other route; the
// usual 404 when it answers nothing.
function probeRoute(app: Hono, probe: MetricsCollectorOptions['probe']) {
  app.get(
    COLLECTOR_ROUTES.RPC_PROBE,
    async (context) =>
      (await probe?.(context.req.raw)) ??
      rejection(context, COLLECTOR_ERRORS.NOT_FOUND),
  );
}

export function createMetricsCollector(options: MetricsCollectorOptions) {
  const now = options.now ?? Date.now;
  const development = options.development === true;
  const resolved = resolve(options);
  const app = new Hono();

  // Before routing: https, fail closed on storage and every limiter, then the per-address (/64) limit.
  // Public stats reads have their own per-address budget, so readers and uploads never block each other.
  app.use('*', async (context: Context, next: Next) => {
    if (!secureRequest(context.req.url, development))
      context.res = rejection(context, COLLECTOR_ERRORS.HTTPS_REQUIRED);
    else if (!resolved)
      context.res = rejection(context, COLLECTOR_ERRORS.UNAVAILABLE);
    else if (
      !(await allowed(
        context.req.path.startsWith(COLLECTOR_ROUTES.STATS_PREFIX)
          ? resolved.read
          : resolved.ip,
        ipKey(context.req.header(COLLECTOR_HEADERS.CLIENT_IP)),
      ))
    )
      context.res = rejection(context, COLLECTOR_ERRORS.RATE_LIMITED);
    else await next();
    finishHeaders(context);
  });

  app.get(COLLECTOR_ROUTES.HEALTH, (context) =>
    context.json({ ok: true }, COLLECTOR_STATUS.OK),
  );

  // Both upload routes share admission, body cap, error mapping and the write budget.
  const upload = (ingest: typeof ingestUpload) =>
    [
      // Refuses an oversized body from Content-Length or while streaming, before buffering it.
      bodyLimit({
        maxSize: COLLECTOR_LIMITS.maxBodyBytes,
        onError: (context) =>
          rejection(context, COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE),
      }),
      async (context: Context) => {
        const { storage, node, global } = resolved!;
        if (
          !JSON_CONTENT_TYPE.test(
            context.req.header(COLLECTOR_HEADERS.CONTENT_TYPE) ?? '',
          )
        )
          return rejection(context, COLLECTOR_ERRORS.INVALID_UPLOAD);
        const bytes = new Uint8Array(await context.req.arrayBuffer());
        try {
          const result = await ingest(bytes, {
            storage,
            now: now(),
            admitNode: (nodeId) => allowed(node, nodeId),
            admitWrite: () => allowed(global, GLOBAL_LIMIT_KEY),
          });
          return context.json(result, COLLECTOR_STATUS.OK);
        } catch (error) {
          if (error instanceof StaleUploadError)
            return context.json(
              {
                error: COLLECTOR_ERRORS.STALE_UPLOAD,
                serverTime: error.serverTime,
              },
              COLLECTOR_STATUS.CONFLICT,
            );
          if (error instanceof CollectorError)
            return rejection(context, error.code);
          throw error;
        }
      },
    ] as const;
  app.post(COLLECTOR_ROUTES.RECEIPTS, ...upload(ingestUpload));
  app.post(COLLECTOR_ROUTES.OBSERVATIONS, ...upload(ingestObservations));
  statsRoutes(app, options.stats, now);
  probeRoute(app, options.probe);

  app.notFound((context) => rejection(context, COLLECTOR_ERRORS.NOT_FOUND));
  // Unexpected failures answer one static code and log nothing about the request.
  app.onError((_error, context) => {
    const response = context.json(
      { error: COLLECTOR_INTERNAL_ERROR },
      COLLECTOR_STATUS.INTERNAL_SERVER_ERROR,
    );
    finishHeaders(context);
    return response;
  });
  return app;
}
