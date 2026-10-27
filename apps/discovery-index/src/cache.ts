// Owns the index's read caches: the GET /v1/sellers response cache (normalized keys, 200s only,
// fail-open) and the per-app health record count. It never caches errors, publishes or client data.
import {
  DISCOVERY_INDEX_LIMITS,
  INDEX_HEADER_VALUES,
  INDEX_HEADERS,
  INDEX_ROUTES,
  INDEX_STATUS,
} from './constants.js';
import type { SellersQuery } from './sellers.js';
import type { DiscoveryStorage } from './storage.js';

// The subset of the Workers Cache API (caches.default) the index uses. Entries live as long as
// the stored response's Cache-Control allows (public, max-age=10 for sellers pages).
export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

// One key per distinct page: the parsed query only (unknown or repeated parameters never get
// here), the effective limit, and parameters in sorted order.
export function sellersCacheKey(url: string, query: SellersQuery) {
  const params = new URLSearchParams();
  if (query.after)
    params.set('cursor', `${query.after.issuedAt}-${query.after.nodeId}`);
  params.set('limit', String(query.limit));
  params.set('model', query.model);
  return `${new URL(url).origin}${INDEX_ROUTES.SELLERS}?${params}`;
}

// A cache failure is a miss; a hit gets fresh, mutable headers. The edge may rewrite a stored
// entry's Cache-Control and Expires (the zone's Browser Cache TTL), so the sellers policy is
// re-asserted and any Expires is dropped.
export async function cachedPage(
  cache: ResponseCache | undefined,
  key: string,
): Promise<Response | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (hit?.status !== INDEX_STATUS.OK) return null;
    const page = new Response(hit.body, hit);
    page.headers.set(
      INDEX_HEADERS.CACHE_CONTROL,
      INDEX_HEADER_VALUES.SELLERS_CACHE,
    );
    page.headers.delete(INDEX_HEADERS.EXPIRES);
    return page;
  } catch {
    return null;
  }
}

// Stores a copy of a 200 page; failures are ignored.
export async function storePage(
  cache: ResponseCache | undefined,
  key: string,
  response: Response,
) {
  if (!cache || response.status !== INDEX_STATUS.OK) return;
  try {
    await cache.put(key, response.clone());
  } catch {
    // Fail open: the page was already served from storage.
  }
}

// Unexpired record count for /v1/health, reused for healthCacheMs per app; reset after an
// accepted publish so this app's own writes show at once. A stale count reads storage only when
// `admit` allows it, else read returns null.
export function recordCounter() {
  let cached: { value: number; at: number } | null = null;
  return {
    async read(
      storage: DiscoveryStorage,
      now: number,
      admit: () => Promise<boolean>,
    ) {
      if (
        cached &&
        now >= cached.at &&
        now - cached.at < DISCOVERY_INDEX_LIMITS.healthCacheMs
      )
        return cached.value;
      if (!(await admit())) return null;
      const value = await storage.count(now);
      cached = { value, at: now };
      return value;
    },
    reset() {
      cached = null;
    },
  };
}
export type RecordCounter = ReturnType<typeof recordCounter>;
