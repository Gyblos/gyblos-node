// Owns the Cloudflare Worker entry for discovery.gyblos.com: maps bindings, the publish allowlist and
// Solana RPC secrets and the Cache API (caches.default, when present) to the app, fails closed.
// Development relaxations are never enabled here; nothing runs on import.
import type { ExecutionContext } from 'hono';

import { readRegistryIdentity } from '@gyblos/identity/resolution';
import { createIdentityResolutionRpc } from '@gyblos/identity/resolution-rpc';

import {
  createDiscoveryIndex,
  type DiscoveryIndex,
  type ResponseCache,
} from './app';
import {
  DISCOVERY_DB_BINDING,
  DISCOVERY_LIMITERS,
  DISCOVERY_PUBLISH_ALLOWLIST_BINDING,
  DISCOVERY_SOLANA_RPC_BINDING,
} from './constants';
import type { DiscoveryLimiters, RateLimiter } from './limits';
import { parsePublishAllowlist } from './publishers';
import { createD1RegistrationStore } from './registration-store-d1';
import type { RegistryReader } from './registrations';
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

function isResponseCache(value: unknown): value is ResponseCache {
  return hasMethod(value, 'match') && hasMethod(value, 'put');
}

function isExecutionContext(value: unknown): value is ExecutionContext {
  return (
    hasMethod(value, 'waitUntil') && hasMethod(value, 'passThroughOnException')
  );
}

// The Workers Cache API; outside Workers (or without it) the app runs uncached.
function defaultCache(): ResponseCache | undefined {
  const cache = binding(Reflect.get(globalThis, 'caches'), 'default');
  return isResponseCache(cache) ? cache : undefined;
}

function limitersOf(bindings: unknown): DiscoveryLimiters {
  const limiters: DiscoveryLimiters = {};
  for (const name of Object.values(DISCOVERY_LIMITERS)) {
    const value = binding(bindings, name);
    if (isLimiter(value)) limiters[name] = value;
  }
  return limiters;
}

// Workers throws on `redirect: 'error'` (it supports only follow and manual). The registry reader asks for
// it, so it becomes manual here: a redirect then arrives as a 3xx, which the reader refuses as not ok.
export function edgeFetch(
  fetcher: typeof fetch = fetch,
): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) =>
    fetcher(url, {
      ...init,
      redirect: init.redirect === 'error' ? 'manual' : init.redirect,
    });
}

// The 8004 registry through the RPC secret; a missing or refused URL leaves registrations at 503.
function registryOf(bindings: unknown): RegistryReader | undefined {
  const url = binding(bindings, DISCOVERY_SOLANA_RPC_BINDING);
  if (typeof url !== 'string') return undefined;
  try {
    const rpc = createIdentityResolutionRpc(url, { fetch: edgeFetch() });
    return { lookup: (nodeId) => readRegistryIdentity(rpc, nodeId) };
  } catch {
    return undefined;
  }
}

// Bindings are fixed for an isolate, so one app (its prune throttle and the parsed allowlist)
// is kept per bindings object. A missing or malformed allowlist leaves only registered NodeIds.
function appFor(bindings: unknown, cache: WeakMap<object, DiscoveryIndex>) {
  const key = bindings && typeof bindings === 'object' ? bindings : cache;
  let app = cache.get(key);
  if (!app) {
    const database = binding(bindings, DISCOVERY_DB_BINDING);
    app = createDiscoveryIndex({
      storage: isDatabase(database) ? createD1Storage(database) : undefined,
      registrations: isDatabase(database)
        ? createD1RegistrationStore(database)
        : undefined,
      registry: registryOf(bindings),
      limiters: limitersOf(bindings),
      publishers: parsePublishAllowlist(
        binding(bindings, DISCOVERY_PUBLISH_ALLOWLIST_BINDING),
      ),
      cache: defaultCache(),
      development: false,
    });
    cache.set(key, app);
  }
  return app;
}

export function createWorker() {
  const cache = new WeakMap<object, DiscoveryIndex>();
  return {
    fetch(
      request: Request,
      bindings: unknown,
      context?: unknown,
    ): Promise<Response> | Response {
      return appFor(bindings, cache).fetch(
        request,
        undefined,
        isExecutionContext(context) ? context : undefined,
      );
    },
  };
}

// The default worker creates its app cache on the first request, not on import.
let worker: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, bindings: unknown, context?: unknown) {
    worker ??= createWorker();
    return worker.fetch(request, bindings, context);
  },
};
