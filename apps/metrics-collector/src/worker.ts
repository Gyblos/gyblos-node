// Owns the Cloudflare Worker entry: maps the D1 binding and rate limiters to the app and fails closed.
// Development relaxations are never enabled here; nothing runs on import.
import { DEVNET_RPC_URL } from '@gyblos/config/network';

import { runAggregation } from './aggregate';
import {
  createMetricsCollector,
  type CollectorLimiters,
  type RateLimiter,
} from './app';
import { chainEndpoints } from './chain/endpoints';
import {
  ChainIndexError,
  runChainIndex,
  type ChainIndexResult,
} from './chain/indexer';
import { ChainShapeError } from './chain/json';
import { ChainRpcError, chainRpcUrl, createChainRpc } from './chain/rpc';
import {
  CHAIN_INDEX,
  COLLECTOR_AGGREGATION_FAILED,
  COLLECTOR_CHAIN_INDEX_FAILED,
  COLLECTOR_CHAIN_INDEX_RUN,
  COLLECTOR_DB_BINDING,
  COLLECTOR_LIMITERS,
  COLLECTOR_ROUTES,
  COLLECTOR_SOLANA_RPC_BINDINGS,
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
  if (result.chain.scanFailed)
    console.warn(COLLECTOR_AGGREGATION_FAILED, 'chain scan');
  if (result.chain.failed.length)
    console.warn(
      COLLECTOR_AGGREGATION_FAILED,
      `chain ${result.chain.failed.join(',')}`,
    );
  return result;
}

// The scheduled chain read, when a database is bound: on the free public devnet RPC, and on the paid
// one (the secret, if set) only after the public one rate-limits the run. Every run logs its calls
// per endpoint, so a slow free endpoint is visible before relying on the paid one. A failure logs a
// static code with the phase and the error's class only (never the URL, which may carry a provider
// key) and leaves the cursor at the last stored batch.
const chainFailureReason = (cause: unknown) =>
  cause instanceof ChainRpcError || cause instanceof ChainShapeError
    ? cause.message
    : '';
const usageLine = (result: ChainIndexResult) => {
  const { primary, fallback, onFallback } = result.usage;
  return [
    `public=${primary.calls}`,
    `publicLimited=${primary.rateLimited}`,
    `paid=${fallback.calls}`,
    `paidLimited=${fallback.rateLimited}`,
    `onPaid=${onFallback}`,
    `endpoint=${result.usage.endpoint}`,
    `listed=${result.listed}`,
    `read=${result.read}`,
    `followed=${result.followed}`,
    `flooded=${result.flooded}`,
    `accounts=${result.channels}`,
    `undecodable=${result.undecodable}`,
    `backlog=${result.backlog}`,
    `skipped=${result.skipped}`,
  ].join(' ');
};

export async function scheduledChainIndex(
  bindings: unknown,
  now: number,
  fetcher: typeof fetch = fetch,
  wait?: (milliseconds: number) => Promise<void>,
) {
  const database = binding(bindings, COLLECTOR_DB_BINDING);
  if (!isDatabase(database)) return undefined;
  const keyed = COLLECTOR_SOLANA_RPC_BINDINGS.flatMap((name) => {
    const configured = binding(bindings, name);
    const url = chainRpcUrl(configured);
    // A secret that is set but not usable (http, credentials, a fragment) must be visible.
    if (configured !== undefined && configured !== '' && !url)
      console.warn(
        COLLECTOR_CHAIN_INDEX_FAILED,
        'config',
        'rejected rpc url',
        name,
      );
    return url
      ? [
          {
            rpc: createChainRpc(url, fetcher),
            limits: {
              budget: CHAIN_INDEX.paidCallsPerRun,
              minIntervalMs: CHAIN_INDEX.paidIntervalMs,
            },
          },
        ]
      : [];
  });
  const rpc = chainEndpoints(
    {
      rpc: createChainRpc(DEVNET_RPC_URL, fetcher),
      limits: {
        budget: CHAIN_INDEX.publicCallsPerRun,
        minIntervalMs: CHAIN_INDEX.publicIntervalMs,
      },
    },
    keyed,
    wait ? { wait } : {},
  );
  try {
    const result = await runChainIndex(database, rpc, now);
    console.log(COLLECTOR_CHAIN_INDEX_RUN, usageLine(result));
    return result;
  } catch (error) {
    const phase = error instanceof ChainIndexError ? error.phase : 'start';
    const cause = error instanceof ChainIndexError ? error.cause : error;
    const { primary, fallback } = rpc.usage();
    // Static reasons only (an HTTP status, an RPC error code, a shape location), never the URL.
    console.warn(
      COLLECTOR_CHAIN_INDEX_FAILED,
      phase,
      cause instanceof Error ? cause.name : 'unknown',
      chainFailureReason(cause),
      `public=${primary.calls} publicLimited=${primary.rateLimited} paid=${fallback.calls} paidLimited=${fallback.rateLimited}`,
    );
    return undefined;
  }
}
// Aggregates first (cheap, bounded), then the chain read, so a slow RPC never delays the stats.
async function scheduledRun(bindings: unknown, now: number) {
  await scheduledAggregation(bindings, now);
  await scheduledChainIndex(bindings, now);
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
