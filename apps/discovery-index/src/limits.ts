// Owns rate-limit resolution: every Cloudflare binding is required (fail closed), except loopback
// development counters, which only an explicit development app on a loopback host can use.
import {
  DEVELOPMENT_LIMITS,
  DISCOVERY_LIMITERS,
  LOOPBACK_HOSTS,
  type DiscoveryLimiterName,
} from './constants';

// The subset of a Cloudflare rate-limit binding the index uses.
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export type DiscoveryLimiters = Partial<
  Record<DiscoveryLimiterName, RateLimiter>
>;
export type ResolvedLimiters = Record<DiscoveryLimiterName, RateLimiter>;

function complete(limiters: DiscoveryLimiters): ResolvedLimiters | null {
  const ip = limiters[DISCOVERY_LIMITERS.IP];
  const publish = limiters[DISCOVERY_LIMITERS.PUBLISH];
  const node = limiters[DISCOVERY_LIMITERS.NODE];
  const read = limiters[DISCOVERY_LIMITERS.READ];
  if (!ip || !publish || !node || !read) return null;
  return {
    [DISCOVERY_LIMITERS.IP]: ip,
    [DISCOVERY_LIMITERS.PUBLISH]: publish,
    [DISCOVERY_LIMITERS.NODE]: node,
    [DISCOVERY_LIMITERS.READ]: read,
  };
}

// Fixed-window in-memory counters, bounded in size; state lives in the app instance.
function developmentLimiters(now: () => number): ResolvedLimiters {
  const counters = new Map<string, number>();
  const counter = (name: string): RateLimiter => ({
    async limit({ key }) {
      const bucket = `${name}:${key}:${Math.floor(now() / DEVELOPMENT_LIMITS.windowMs)}`;
      if (counters.size > DEVELOPMENT_LIMITS.maxBuckets) counters.clear();
      const count = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, count);
      return { success: count <= DEVELOPMENT_LIMITS.perMinute };
    },
  });
  return {
    [DISCOVERY_LIMITERS.IP]: counter(DISCOVERY_LIMITERS.IP),
    [DISCOVERY_LIMITERS.PUBLISH]: counter(DISCOVERY_LIMITERS.PUBLISH),
    [DISCOVERY_LIMITERS.NODE]: counter(DISCOVERY_LIMITERS.NODE),
    [DISCOVERY_LIMITERS.READ]: counter(DISCOVERY_LIMITERS.READ),
  };
}

// Returns the per-request resolver: configured bindings, else development counters on
// loopback when `development` is set, else null (the caller answers 503).
export function limiterResolver(
  configured: DiscoveryLimiters,
  development: boolean,
  now: () => number,
) {
  const bound = complete(configured);
  const local = development ? developmentLimiters(now) : null;
  return (url: string): ResolvedLimiters | null => {
    if (local && LOOPBACK_HOSTS.has(new URL(url).hostname)) return local;
    return bound;
  };
}

// A limiter that refuses or fails counts as limited (fail closed).
export async function allowed(limiter: RateLimiter, key: string) {
  try {
    return (await limiter.limit({ key })).success === true;
  } catch {
    return false;
  }
}
