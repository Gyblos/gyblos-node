// Owns the Cloudflare Worker entry: maps the D1 binding and rate limiters to the app and fails closed.
// Development relaxations are never enabled here; nothing runs on import.
import { runAggregation } from './aggregate';
import {
  createMetricsCollector,
  type CollectorLimiters,
  type RateLimiter,
} from './app';
import { COLLECTOR_DB_BINDING, COLLECTOR_LIMITERS } from './constants';
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

// The scheduled run recomputes the days whose raw rows changed. Without a database it does nothing;
// a failure leaves the days dirty for the next run.
export async function scheduledAggregation(bindings: unknown, now: number) {
  const database = binding(bindings, COLLECTOR_DB_BINDING);
  if (isDatabase(database)) await runAggregation(database, now);
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
let worker: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, bindings: unknown) {
    worker ??= createWorker();
    return worker.fetch(request, bindings);
  },
  scheduled(
    controller: { scheduledTime: number },
    bindings: unknown,
    context: ExecutionContext,
  ) {
    context.waitUntil(scheduledAggregation(bindings, controller.scheduledTime));
  },
};
