// Resolved app settings: options with their defaults, plus the per-instance throttles and caches.
import { recordCounter, type RecordCounter, type ResponseCache } from './cache';
import { DISCOVERY_INDEX_LIMITS } from './constants';
import {
  limiterResolver,
  type DiscoveryLimiters,
  type ResolvedLimiters,
} from './limits';
import type { DiscoveryPublishers } from './publishers';
import type { RegistrationStore } from './registration-store';
import type { RegistryReader } from './registrations';
import type { DiscoveryStorage } from './storage';
import { uptimeRecorder } from './uptime';

export interface DiscoveryIndexOptions {
  // Missing storage or any missing limiter fails closed with 503 DISCOVERY_UNAVAILABLE.
  storage?: DiscoveryStorage;
  limiters?: DiscoveryLimiters;
  // Who may publish. Missing means closed: every publish is 503 DISCOVERY_UNAVAILABLE,
  // reads are unaffected. Development never relaxes it.
  publishers?: DiscoveryPublishers;
  // NodeIds admitted through /v1/registrations; they may publish too. With no allowlist either,
  // publishing is closed.
  registrations?: RegistrationStore;
  // The 8004 registry reader /v1/registrations verifies against. Missing, that route answers 503.
  registry?: RegistryReader;
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

export interface IndexSettings {
  now: () => number;
  development: boolean;
  storage: DiscoveryStorage | undefined;
  publishers: DiscoveryPublishers | undefined;
  registrations: RegistrationStore | undefined;
  registry: RegistryReader | undefined;
  cache: ResponseCache | undefined;
  records: RecordCounter;
  resolve: (url: string) => ResolvedLimiters | null;
  prune: (now: number) => Promise<void>;
  markSeen: (nodeId: string, now: number) => Promise<void>;
  maxNodes: number;
  maxResponseBytes: number;
}

export function settingsOf(options: DiscoveryIndexOptions): IndexSettings {
  const now = options.now ?? Date.now;
  const development = options.development === true;
  return {
    now,
    development,
    storage: options.storage,
    publishers: options.publishers,
    registrations: options.registrations,
    registry: options.registry,
    cache: options.cache,
    records: recordCounter(),
    resolve: limiterResolver(options.limiters ?? {}, development, now),
    prune: pruneThrottle(
      options.storage,
      options.pruneIntervalMs ?? DISCOVERY_INDEX_LIMITS.pruneIntervalMs,
    ),
    markSeen: uptimeRecorder(options.storage),
    maxNodes: options.maxNodes ?? DISCOVERY_INDEX_LIMITS.maxNodes,
    maxResponseBytes:
      options.maxResponseBytes ?? DISCOVERY_INDEX_LIMITS.maxResponseBytes,
  };
}
