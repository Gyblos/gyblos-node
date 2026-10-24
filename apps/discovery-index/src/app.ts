// Owns the discovery index HTTP app: an untrusted cache of node-signed public v2 records.
// It never vouches for identity, never stores or logs IPs and answers only static error codes.
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { isJsonContentType } from './body.js';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
  INDEX_HEADER_VALUES,
  INDEX_HEADERS,
  INDEX_ROUTES,
  INDEX_STATUS,
  PUBLIC_READ_ROUTES,
  type DiscoveryLimiterName,
  type IndexErrorCode,
} from './constants.js';
import { IndexError, statusOf } from './errors.js';
import { ipKey } from './ip-key.js';
import {
  allowed,
  limiterResolver,
  type DiscoveryLimiters,
  type ResolvedLimiters,
} from './limits.js';
import { acceptRecord, type PublishContext } from './publish.js';
import {
  parseSellersQuery,
  sellersPage,
  type SellersQuery,
} from './sellers.js';
import type { DiscoveryStorage } from './storage.js';

export interface DiscoveryIndexOptions {
  // Missing storage or any missing limiter fails closed with 503 DISCOVERY_UNAVAILABLE.
  storage?: DiscoveryStorage;
  limiters?: DiscoveryLimiters;
  now?: () => number;
  // Loopback hosts only: missing limiters become in-memory counters. Storage is never relaxed.
  // The Worker entry always passes false.
  development?: boolean;
  maxNodes?: number;
  maxResponseBytes?: number;
  pruneIntervalMs?: number;
}

interface IndexVariables {
  storage: DiscoveryStorage;
  limiters: ResolvedLimiters;
}
interface IndexEnv {
  Variables: IndexVariables;
}
type IndexContext = Context<IndexEnv>;

function rejection(context: Context, code: IndexErrorCode) {
  if (code === INDEX_ERRORS.RATE_LIMITED)
    context.header(
      INDEX_HEADERS.RETRY_AFTER,
      INDEX_HEADER_VALUES.RETRY_AFTER_SECONDS,
    );
  return context.json({ error: code }, statusOf(code));
}

function clientKey(context: Context) {
  return ipKey(context.req.header(INDEX_HEADERS.CLIENT_IP));
}

function clientAllowed(context: IndexContext, name: DiscoveryLimiterName) {
  return allowed(context.get('limiters')[name], clientKey(context));
}

function finishHeaders(context: Context) {
  const headers = context.res.headers;
  if (!headers.has(INDEX_HEADERS.CACHE_CONTROL))
    headers.set(INDEX_HEADERS.CACHE_CONTROL, INDEX_HEADER_VALUES.NO_STORE);
  const read = context.req.method === 'GET' || context.req.method === 'HEAD';
  if (read && PUBLIC_READ_ROUTES.has(context.req.path))
    headers.set(INDEX_HEADERS.CORS_ORIGIN, INDEX_HEADER_VALUES.ANY_ORIGIN);
  headers.set(INDEX_HEADERS.ROBOTS, INDEX_HEADER_VALUES.NOINDEX);
}

// Per-app prune throttle (the Worker keeps one app per isolate).
function pruneThrottle(
  storage: DiscoveryStorage | undefined,
  intervalMs: number,
) {
  let prunedAt = -Infinity;
  return async (now: number) => {
    if (!storage || now - prunedAt < intervalMs) return;
    prunedAt = now;
    await storage.prune(now);
  };
}

interface IndexSettings {
  now: () => number;
  storage: DiscoveryStorage | undefined;
  resolve: (url: string) => ResolvedLimiters | null;
  prune: (now: number) => Promise<void>;
  maxNodes: number;
  maxResponseBytes: number;
}

function settingsOf(options: DiscoveryIndexOptions): IndexSettings {
  const now = options.now ?? Date.now;
  return {
    now,
    storage: options.storage,
    resolve: limiterResolver(
      options.limiters ?? {},
      options.development === true,
      now,
    ),
    prune: pruneThrottle(
      options.storage,
      options.pruneIntervalMs ?? DISCOVERY_INDEX_LIMITS.pruneIntervalMs,
    ),
    maxNodes: options.maxNodes ?? DISCOVERY_INDEX_LIMITS.maxNodes,
    maxResponseBytes:
      options.maxResponseBytes ?? DISCOVERY_INDEX_LIMITS.maxResponseBytes,
  };
}

// Fail closed before routing: storage and every limiter, then the per-IP(/64) limit.
function gate(settings: IndexSettings) {
  return async (context: IndexContext, next: Next) => {
    const limiters = settings.resolve(context.req.url);
    if (!settings.storage || !limiters)
      context.res = rejection(context, INDEX_ERRORS.UNAVAILABLE);
    else if (
      !(await allowed(limiters[DISCOVERY_LIMITERS.IP], clientKey(context)))
    )
      context.res = rejection(context, INDEX_ERRORS.RATE_LIMITED);
    else {
      context.set('storage', settings.storage);
      context.set('limiters', limiters);
      await next();
    }
    finishHeaders(context);
  };
}

function publishHandler(settings: IndexSettings) {
  return async (context: IndexContext) => {
    if (!(await clientAllowed(context, DISCOVERY_LIMITERS.PUBLISH)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    if (!isJsonContentType(context.req.header(INDEX_HEADERS.CONTENT_TYPE)))
      return rejection(context, INDEX_ERRORS.INVALID_RECORD);
    const bytes = await context.req.arrayBuffer();
    if (bytes.byteLength > DISCOVERY_INDEX_LIMITS.maxBodyBytes)
      return rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE);
    const publish: PublishContext = {
      storage: context.get('storage'),
      limiters: context.get('limiters'),
      now: settings.now(),
      maxNodes: settings.maxNodes,
      prune: settings.prune,
    };
    try {
      await acceptRecord(bytes, publish);
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    return context.json({ ok: true }, INDEX_STATUS.CREATED);
  };
}

function sellersHandler(settings: IndexSettings) {
  return async (context: IndexContext) => {
    let query: SellersQuery;
    try {
      query = await parseSellersQuery(context.req.url);
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    const body = await sellersPage(
      context.get('storage'),
      query,
      settings.now(),
      settings.maxResponseBytes,
    );
    return context.body(body, INDEX_STATUS.OK, {
      [INDEX_HEADERS.CONTENT_TYPE]: INDEX_HEADER_VALUES.JSON,
      [INDEX_HEADERS.CACHE_CONTROL]: INDEX_HEADER_VALUES.SELLERS_CACHE,
    });
  };
}

export function createDiscoveryIndex(options: DiscoveryIndexOptions = {}) {
  const settings = settingsOf(options);
  const app = new Hono<IndexEnv>();
  app.use('*', gate(settings));
  // Storage failures map to one static code; details are neither returned nor logged.
  app.onError((_error, context) =>
    rejection(context, INDEX_ERRORS.UNAVAILABLE),
  );
  app.notFound((context) => rejection(context, INDEX_ERRORS.NOT_FOUND));
  app.post(
    INDEX_ROUTES.RECORDS,
    bodyLimit({
      maxSize: DISCOVERY_INDEX_LIMITS.maxBodyBytes,
      onError: (context) => rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
    }),
    publishHandler(settings),
  );
  app.get(INDEX_ROUTES.SELLERS, sellersHandler(settings));
  app.get(INDEX_ROUTES.HEALTH, async (context) =>
    context.json({
      ok: true,
      records: await context.get('storage').count(settings.now()),
    }),
  );
  return app;
}

export type DiscoveryIndex = ReturnType<typeof createDiscoveryIndex>;
