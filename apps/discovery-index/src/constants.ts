// Owns the discovery index's canonical values: wire error codes, statuses, routes, limits and binding names.
// It must not hold record formats or signing domains (protocol owns those) or operator URLs (config).
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

// Static `error` values on the wire (docs/discovery.md, "Running an index").
export const INDEX_ERRORS = {
  INVALID_RECORD: 'INVALID_RECORD',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  EXPIRED_RECORD: 'EXPIRED_RECORD',
  UNKNOWN_CATALOG: 'UNKNOWN_CATALOG',
  STALE_RECORD: 'STALE_RECORD',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_QUERY: 'INVALID_QUERY',
  NOT_FOUND: 'NOT_FOUND',
  // The claimed NodeId is not on the publish allowlist (checked before the signature).
  PUBLISH_NOT_ALLOWED: 'PUBLISH_NOT_ALLOWED',
  // The request did not use https (400 for every method, never a redirect).
  HTTPS_REQUIRED: 'HTTPS_REQUIRED',
  UNAVAILABLE: 'DISCOVERY_UNAVAILABLE',
} as const;
export type IndexErrorCode = (typeof INDEX_ERRORS)[keyof typeof INDEX_ERRORS];

export const INDEX_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type IndexStatus = (typeof INDEX_STATUS)[keyof typeof INDEX_STATUS];

// Routes at the root of the index's own host (discovery.gyblos.com).
export const INDEX_ROUTES = {
  RECORDS: '/v1/records',
  SELLERS: '/v1/sellers',
  HEALTH: '/v1/health',
} as const;
// Public reads are CORS-readable on every status, errors included.
export const PUBLIC_READ_ROUTES: ReadonlySet<string> = new Set([
  INDEX_ROUTES.SELLERS,
  INDEX_ROUTES.HEALTH,
]);

export const INDEX_HEADERS = {
  CACHE_CONTROL: 'Cache-Control',
  EXPIRES: 'Expires',
  CORS_ORIGIN: 'Access-Control-Allow-Origin',
  CONTENT_TYPE: 'Content-Type',
  RETRY_AFTER: 'Retry-After',
  ROBOTS: 'X-Robots-Tag',
  CONTENT_TYPE_OPTIONS: 'X-Content-Type-Options',
  CLIENT_IP: 'CF-Connecting-IP',
} as const;

export const INDEX_HEADER_VALUES = {
  NO_STORE: 'no-store',
  SELLERS_CACHE: 'public, max-age=10',
  ANY_ORIGIN: '*',
  NOINDEX: 'noindex',
  NOSNIFF: 'nosniff',
  JSON: 'application/json; charset=UTF-8',
  RETRY_AFTER_SECONDS: '60',
} as const;

export const DISCOVERY_INDEX_LIMITS = {
  // A 32 KiB canonical record plus envelope/signature headroom; the client uses the same cap.
  maxBodyBytes: 34_816,
  defaultSellers: 50,
  maxSellers: 200,
  maxResponseBytes: 1024 * 1024,
  // Bytes reserved for the page framing around the seller entries.
  responseFramingBytes: 128,
  // Soft cap on tracked NodeIds, checked before a new NodeId is admitted. NodeIds are free
  // to mint; each slot is held until its high-water retention ends (about 20 minutes),
  // bounded by the per-IP(/64) publish limit.
  maxNodes: 10_000,
  // Expired rows are pruned when a new NodeId publishes, at most once per interval per app instance.
  pruneIntervalMs: 60_000,
  // /v1/health reuses its record count this long per app instance.
  healthCacheMs: 30_000,
  // High-water marks outlive the record by one maximum catalog lifetime.
  retentionMs: PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
  maxJsonDepth: 16,
  maxLimitDigits: 6,
  maxCursorIssuedDigits: 16,
} as const;

// Cloudflare rate-limit binding names (wrangler.jsonc); keyed by IP(/64) or NodeId, never stored,
// except READ, which caps storage reads under one constant key.
export const DISCOVERY_LIMITERS = {
  IP: 'DISCOVERY_IP_LIMITER',
  PUBLISH: 'DISCOVERY_PUBLISH_LIMITER',
  NODE: 'DISCOVERY_NODE_LIMITER',
  READ: 'DISCOVERY_READ_LIMITER',
} as const;
export type DiscoveryLimiterName =
  (typeof DISCOVERY_LIMITERS)[keyof typeof DISCOVERY_LIMITERS];

// Key for the read limiter. Cloudflare counts per location, so this caps storage reads per
// Cloudflare location, not exactly worldwide.
export const READ_LIMIT_KEY = 'global';

export const DISCOVERY_DB_BINDING = 'DISCOVERY_DB';

// Worker secret naming who may publish: `*` (open) or comma-separated NodeIds. Missing,
// empty or malformed closes publishing (503); reads stay public either way.
export const DISCOVERY_PUBLISH_ALLOWLIST_BINDING =
  'DISCOVERY_PUBLISH_ALLOWLIST';
export const PUBLISH_ALLOWLIST = {
  open: '*',
  separator: ',',
  maxEntries: 1000,
  nodeId: /^[0-9a-f]{64}$/,
} as const;
// Publish modes, also reported by /v1/health (never the NodeIds themselves).
export const PUBLISH_MODES = {
  CLOSED: 'closed',
  ALLOWLIST: 'allowlist',
  OPEN: 'open',
} as const;
export type PublishMode = (typeof PUBLISH_MODES)[keyof typeof PUBLISH_MODES];

// Loopback-only development counters (never used by the Worker entry). The host list is local
// because the @gyblos/config root also exports Node path helpers that a Worker bundle cannot load.
export const DEVELOPMENT_LIMITS = {
  perMinute: 120,
  windowMs: 60_000,
  maxBuckets: 2_000,
} as const;
// Requests must use https; development apps also accept http on a loopback host.
export const INDEX_PROTOCOLS = {
  SECURE: 'https:',
  LOOPBACK: 'http:',
} as const;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
// Rate-limit key used when no client address header is present.
export const LOCAL_CLIENT_KEY = 'local';

export const IPV6 = {
  groups: 8,
  prefixGroups: 4,
  hexRadix: 16,
} as const;
