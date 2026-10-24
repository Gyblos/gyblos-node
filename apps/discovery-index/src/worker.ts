// Owns the Cloudflare Worker entry for discovery.gyblos.com: maps bindings to the app, fails closed.
// Development relaxations are never enabled here; nothing runs on import.
import { createDiscoveryIndex, type DiscoveryIndex } from './app.js';
import { DISCOVERY_DB_BINDING, DISCOVERY_LIMITERS } from './constants.js';
import type { DiscoveryLimiters, RateLimiter } from './limits.js';
import { createD1Storage, type D1Database } from './storage-d1.js';

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

function limitersOf(bindings: unknown): DiscoveryLimiters {
  const limiters: DiscoveryLimiters = {};
  for (const name of Object.values(DISCOVERY_LIMITERS)) {
    const value = binding(bindings, name);
    if (isLimiter(value)) limiters[name] = value;
  }
  return limiters;
}

// Bindings are fixed for an isolate, so one app (and its prune throttle) is kept per bindings object.
function appFor(bindings: unknown, cache: WeakMap<object, DiscoveryIndex>) {
  const key = bindings && typeof bindings === 'object' ? bindings : cache;
  let app = cache.get(key);
  if (!app) {
    const database = binding(bindings, DISCOVERY_DB_BINDING);
    app = createDiscoveryIndex({
      storage: isDatabase(database) ? createD1Storage(database) : undefined,
      limiters: limitersOf(bindings),
      development: false,
    });
    cache.set(key, app);
  }
  return app;
}

export function createWorker() {
  const cache = new WeakMap<object, DiscoveryIndex>();
  return {
    fetch(request: Request, bindings: unknown): Promise<Response> | Response {
      return appFor(bindings, cache).fetch(request);
    },
  };
}

// The default worker creates its app cache on the first request, not on import.
let worker: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, bindings: unknown) {
    worker ??= createWorker();
    return worker.fetch(request, bindings);
  },
};
