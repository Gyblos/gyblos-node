// Owns the metrics collector's canonical values: wire error codes, statuses, routes, limits and binding
// names. Upload formats and signing domains belong to protocol; receipt policy belongs to core.

// Static `error` values on the wire. Request input is never echoed.
export const COLLECTOR_ERRORS = {
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  // The uploader is not the seller (seller role) or buyer (buyer role) of a receipt, or an offer
  // does not cover the signed amount.
  UPLOAD_POLICY: 'UPLOAD_POLICY',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  // A buyer's disputed fields contradict its own observations.
  INCONSISTENT_DISPUTE: 'INCONSISTENT_DISPUTE',
  // `sentAt` is outside the clock window; the body carries the collector's time to correct and resend.
  STALE_UPLOAD: 'STALE_UPLOAD',
  // The same uploader already used this nonce.
  REPLAYED_UPLOAD: 'REPLAYED_UPLOAD',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  HTTPS_REQUIRED: 'HTTPS_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  UNAVAILABLE: 'COLLECTOR_UNAVAILABLE',
} as const;
export type CollectorErrorCode =
  (typeof COLLECTOR_ERRORS)[keyof typeof COLLECTOR_ERRORS];

export const COLLECTOR_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type CollectorStatus =
  (typeof COLLECTOR_STATUS)[keyof typeof COLLECTOR_STATUS];

export const COLLECTOR_ROUTES = {
  RECEIPTS: '/v1/receipts',
  HEALTH: '/v1/health',
  OBSERVATIONS: '/v1/observations',
} as const;
// What an accepted envelope carried.
export const ENVELOPE_KINDS = {
  RECEIPTS: 'receipts',
  OBSERVATIONS: 'observations',
} as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[keyof typeof ENVELOPE_KINDS];
// Static code for unexpected failures; nothing else is reported.
export const COLLECTOR_INTERNAL_ERROR = 'COLLECTOR_INTERNAL_ERROR';

export const COLLECTOR_HEADERS = {
  CACHE_CONTROL: 'Cache-Control',
  CONTENT_TYPE: 'Content-Type',
  RETRY_AFTER: 'Retry-After',
  ROBOTS: 'X-Robots-Tag',
  CONTENT_TYPE_OPTIONS: 'X-Content-Type-Options',
  CLIENT_IP: 'CF-Connecting-IP',
  CONTENT_LENGTH: 'Content-Length',
} as const;
export const COLLECTOR_HEADER_VALUES = {
  NO_STORE: 'no-store',
  NOINDEX: 'noindex',
  NOSNIFF: 'nosniff',
  RETRY_AFTER_SECONDS: '60',
} as const;
export const COLLECTOR_PROTOCOLS = {
  SECURE: 'https:',
  LOOPBACK: 'http:',
} as const;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

export const COLLECTOR_LIMITS = {
  // Above the envelope's structural maximum (about 170 KiB) plus JSON whitespace.
  maxBodyBytes: 393_216,
  maxJsonDepth: 32,
  // How far `sentAt` may differ from the collector's clock, either way.
  clockWindowMs: 600_000,
  // D1's limit of bound parameters per statement; multi-row writes are chunked under it.
  maxBoundParameters: 100,
} as const;

// Cloudflare bindings (wrangler.jsonc); every one is required and missing ones fail closed.
export const COLLECTOR_DB_BINDING = 'COLLECTOR_DB';
export const COLLECTOR_LIMITERS = {
  // Per client address, before reading the body.
  IP: 'COLLECTOR_IP_LIMITER',
  // Per uploader NodeId, after its envelope signature verifies and before receipt verification, so
  // nobody can spend another node's allowance with unsigned junk.
  NODE: 'COLLECTOR_NODE_LIMITER',
  // One shared write budget for the whole collector, a ceiling on storage growth from free keys.
  GLOBAL: 'COLLECTOR_GLOBAL_LIMITER',
} as const;
export type CollectorLimiterName =
  (typeof COLLECTOR_LIMITERS)[keyof typeof COLLECTOR_LIMITERS];
// Hex radix for envelope ids derived from signatures; not a wire value.
export const HEX_RADIX = 16;

// Fallback rate-limit key when no client address header is present (local development only).
export const LOCAL_CLIENT_KEY = 'local';
// Key of the shared write budget.
export const GLOBAL_LIMIT_KEY = 'global';
export const IPV6 = {
  groups: 8,
  prefixGroups: 4,
  hexRadix: 16,
} as const;
