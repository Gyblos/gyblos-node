// Owns the Cloudflare Worker entry: maps the D1 binding and rate limiters to the app and fails closed.
// Development relaxations are never enabled here; nothing runs on import.
import { runAggregation } from './aggregate';
import {
  createMetricsCollector,
  type CollectorLimiters,
  type RateLimiter,
} from './app';
import { runChainIndex } from './chain/indexer';
import { createChainRpc } from './chain/rpc';
import {
  COLLECTOR_AGGREGATION_FAILED,
  COLLECTOR_CHAIN_INDEX_FAILED,
  COLLECTOR_DB_BINDING,
  COLLECTOR_LIMITERS,
  COLLECTOR_ROUTES,
  COLLECTOR_SOLANA_RPC_BINDING,
  COLLECTOR_STATUS,
} from './constants';
import { statsReader } from './stats-read';
import { createD1Storage, type D1Database } from './storage-d1';

function binding(bindings: unknown, name: string): unknown {
  return bindings && typeof bindings === 'object'
    ? Reflect.get(bindings, name)
    : undefined;
}
function hasMethod(value: unknown, method: string) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, method) === 'function'
  );
}
function isDatabase(value: unknown): value is D1Database {
  return hasMethod(value, 'prepare') && hasMethod(value, 'batch');
}
function isLimiter(value: unknown): value is RateLimiter {
  return hasMethod(value, 'limit');
}

function appFor(bindings: unknown) {
  const database = binding(bindings, COLLECTOR_DB_BINDING);
  const limiters: CollectorLimiters = {};
  for (const name of Object.values(COLLECTOR_LIMITERS)) {
    const value = binding(bindings, name);
    if (isLimiter(value)) limiters[name] = value;
  }
  return createMetricsCollector({
    storage: isDatabase(database) ? createD1Storage(database) : undefined,
    stats: isDatabase(database) ? statsReader(database) : undefined,
    limiters,
    development: false,
  });
}

// One app per bindings object; created on the first request, not on import.
export function createWorker() {
  const apps = new WeakMap<object, ReturnType<typeof appFor>>();
  return {
    fetch(request: Request, bindings: unknown): Response | Promise<Response> {
      const key = bindings && typeof bindings === 'object' ? bindings : apps;
      let app = apps.get(key);
      if (!app) {
        app = appFor(bindings);
        apps.set(key, app);
      }
      return app.fetch(request);
    },
  };
}

// The subset of the Workers Cache API used for public stats answers.
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
// Public stats answers are served from the edge cache when present, so repeated reads cost no D1
// query and no rate-limit budget. Only successful GET answers are stored, keyed by URL alone.
export async function cachedFetch(
  request: Request,
  cache: EdgeCache | undefined,
  context: ExecutionContext,
  answer: (request: Request) => Response | Promise<Response>,
) {
  const url = new URL(request.url);
  if (
    !cache ||
    request.method !== 'GET' ||
    !url.pathname.startsWith(COLLECTOR_ROUTES.STATS_PREFIX)
  )
    return answer(request);
  const key = new Request(url.toString(), { method: 'GET' });
  // A cache failure only costs a database read; it never fails the answer.
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;
  const response = await answer(request);
  if (response.status === COLLECTOR_STATUS.OK)
    context.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

// The scheduled run recomputes the days whose raw rows changed. Without a database it does nothing;
// a failed day stays dirty for the next run.
export async function scheduledAggregation(bindings: unknown, now: number) {
  const database = binding(bindings, COLLECTOR_DB_BINDING);
  if (!isDatabase(database)) return undefined;
  const result = await runAggregation(database, now);
  // Day names only (no request data): a day that keeps failing must be visible in the Worker logs.
  if (result.failed.length)
    console.warn(COLLECTOR_AGGREGATION_FAILED, result.failed.join(','));
  return result;
}

// The scheduled chain read, when a database and a Solana RPC URL are bound. A failure logs a static
// code and leaves the cursor where it was; aggregation runs either way.
export async function scheduledChainIndex(
  bindings: unknown,
  now: number,
  fetcher: typeof fetch = fetch,
) {
  const database = binding(bindings, COLLECTOR_DB_BINDING);
  const url = binding(bindings, COLLECTOR_SOLANA_RPC_BINDING);
  if (!isDatabase(database) || typeof url !== 'string' || !url)
    return undefined;
  try {
    return await runChainIndex(database, createChainRpc(url, fetcher), now);
  } catch (error) {
    // The error's class only: never the RPC URL, which may carry a provider key.
    console.warn(
      COLLECTOR_CHAIN_INDEX_FAILED,
      error instanceof Error ? error.name : 'unknown',
    );
    return undefined;
  }
}
async function scheduledRun(bindings: unknown, now: number) {
  await scheduledChainIndex(bindings, now);
  await scheduledAggregation(bindings, now);
}

const edgeCache = () =>
  (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
let worker: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, bindings: unknown, context: ExecutionContext) {
    worker ??= createWorker();
    const app = worker;
    return cachedFetch(request, edgeCache(), context, (incoming) =>
      app.fetch(incoming, bindings),
    );
  },
  scheduled(
    controller: { scheduledTime: number },
    bindings: unknown,
    context: ExecutionContext,
  ) {
    context.waitUntil(scheduledRun(bindings, controller.scheduledTime));
  },
};
