// Owns the discovery index HTTP app: an untrusted cache of node-signed public v2 records.
// It never vouches for identity, never stores or logs IPs and answers only static error codes.
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { isJsonContentType } from './body';
import {
  cachedPage,
  recordCounter,
  sellersCacheKey,
  storePage,
  type RecordCounter,
  type ResponseCache,
} from './cache';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
  INDEX_HEADER_VALUES,
  INDEX_HEADERS,
  INDEX_PROTOCOLS,
  INDEX_ROUTES,
  INDEX_STATUS,
  LOOPBACK_HOSTS,
  PUBLIC_READ_ROUTES,
  READ_LIMIT_KEY,
  type DiscoveryLimiterName,
  type IndexErrorCode,
} from './constants';
import { IndexError, statusOf } from './errors';
import { ipKey } from './ip-key';
import {
  allowed,
  limiterResolver,
  type DiscoveryLimiters,
  type ResolvedLimiters,
} from './limits';
import { acceptRecord, type PublishContext } from './publish';
import { publishModeOf, type DiscoveryPublishers } from './publishers';
import { parseSellersQuery, sellersPage, type SellersQuery } from './sellers';
import type { DiscoveryStorage } from './storage';

export type { ResponseCache } from './cache';

export interface DiscoveryIndexOptions {
  // Missing storage or any missing limiter fails closed with 503 DISCOVERY_UNAVAILABLE.
  storage?: DiscoveryStorage;
  limiters?: DiscoveryLimiters;
  // Who may publish. Missing means closed: every publish is 503 DISCOVERY_UNAVAILABLE,
  // reads are unaffected. Development never relaxes it.
  publishers?: DiscoveryPublishers;
  // Response cache for GET /v1/sellers (the Worker passes caches.default). Missing means none.
  cache?: ResponseCache;
  now?: () => number;
  // Loopback hosts only: missing limiters become in-memory counters and plain http is accepted.
  // Storage is never relaxed. The Worker entry always passes false.
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

// One budget for storage reads per Cloudflare location, shared by every client.
function readAllowed(context: IndexContext) {
  return allowed(
    context.get('limiters')[DISCOVERY_LIMITERS.READ],
    READ_LIMIT_KEY,
  );
}

function finishHeaders(context: Context) {
  const headers = context.res.headers;
  if (!headers.has(INDEX_HEADERS.CACHE_CONTROL))
    headers.set(INDEX_HEADERS.CACHE_CONTROL, INDEX_HEADER_VALUES.NO_STORE);
  const read = context.req.method === 'GET' || context.req.method === 'HEAD';
  if (read && PUBLIC_READ_ROUTES.has(context.req.path))
    headers.set(INDEX_HEADERS.CORS_ORIGIN, INDEX_HEADER_VALUES.ANY_ORIGIN);
  headers.set(INDEX_HEADERS.ROBOTS, INDEX_HEADER_VALUES.NOINDEX);
  headers.set(INDEX_HEADERS.CONTENT_TYPE_OPTIONS, INDEX_HEADER_VALUES.NOSNIFF);
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
  development: boolean;
  storage: DiscoveryStorage | undefined;
  publishers: DiscoveryPublishers | undefined;
  cache: ResponseCache | undefined;
  records: RecordCounter;
  resolve: (url: string) => ResolvedLimiters | null;
  prune: (now: number) => Promise<void>;
  maxNodes: number;
  maxResponseBytes: number;
}

function settingsOf(options: DiscoveryIndexOptions): IndexSettings {
  const now = options.now ?? Date.now;
  const development = options.development === true;
  return {
    now,
    development,
    storage: options.storage,
    publishers: options.publishers,
    cache: options.cache,
    records: recordCounter(),
    resolve: limiterResolver(options.limiters ?? {}, development, now),
    prune: pruneThrottle(
      options.storage,
      options.pruneIntervalMs ?? DISCOVERY_INDEX_LIMITS.pruneIntervalMs,
    ),
    maxNodes: options.maxNodes ?? DISCOVERY_INDEX_LIMITS.maxNodes,
    maxResponseBytes:
      options.maxResponseBytes ?? DISCOVERY_INDEX_LIMITS.maxResponseBytes,
  };
}

// https only; development apps also accept plain http on a loopback host.
function secureRequest(url: string, development: boolean) {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === INDEX_PROTOCOLS.SECURE ||
    (development &&
      protocol === INDEX_PROTOCOLS.LOOPBACK &&
      LOOPBACK_HOSTS.has(hostname))
  );
}

// Before routing: https, then fail closed on storage and every limiter, then the per-IP(/64) limit.
function gate(settings: IndexSettings) {
  return async (context: IndexContext, next: Next) => {
    const limiters = settings.resolve(context.req.url);
    if (!secureRequest(context.req.url, settings.development))
      context.res = rejection(context, INDEX_ERRORS.HTTPS_REQUIRED);
    else if (!settings.storage || !limiters)
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

function publishHandler(
  settings: IndexSettings,
  publishers: DiscoveryPublishers,
) {
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
      publishers,
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
    settings.records.reset();
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
    const key = sellersCacheKey(context.req.url, query);
    const cached = await cachedPage(settings.cache, key);
    if (cached) return cached;
    if (!(await readAllowed(context)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    const body = await sellersPage(
      context.get('storage'),
      query,
      settings.now(),
      settings.maxResponseBytes,
    );
    const response = context.body(body, INDEX_STATUS.OK, {
      [INDEX_HEADERS.CONTENT_TYPE]: INDEX_HEADER_VALUES.JSON,
      [INDEX_HEADERS.CACHE_CONTROL]: INDEX_HEADER_VALUES.SELLERS_CACHE,
    });
    await inBackground(context, storePage(settings.cache, key, response));
    return response;
  };
}

// Hands work to the Workers execution context when there is one, else awaits it.
function inBackground(context: IndexContext, task: Promise<void>) {
  try {
    context.executionCtx.waitUntil(task);
    return Promise.resolve();
  } catch {
    return task;
  }
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
  const publishers = settings.publishers;
  // Closed publishing answers 503 before the body is read or any publish limit is consumed.
  if (!publishers)
    app.post(INDEX_ROUTES.RECORDS, (context) =>
      rejection(context, INDEX_ERRORS.UNAVAILABLE),
    );
  else
    app.post(
      INDEX_ROUTES.RECORDS,
      bodyLimit({
        maxSize: DISCOVERY_INDEX_LIMITS.maxBodyBytes,
        onError: (context) =>
          rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
      }),
      publishHandler(settings, publishers),
    );
  app.get(INDEX_ROUTES.SELLERS, sellersHandler(settings));
  // Reports the publish mode only, never the allowlisted NodeIds.
  app.get(INDEX_ROUTES.HEALTH, async (context) => {
    const records = await settings.records.read(
      context.get('storage'),
      settings.now(),
      () => readAllowed(context),
    );
    if (records === null) return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    return context.json({
      ok: true,
      records,
      publish: publishModeOf(publishers),
    });
  });
  return app;
}

export type DiscoveryIndex = ReturnType<typeof createDiscoveryIndex>;
