// Owns the discovery client's canonical values: error codes, index wire codes, paths, HTTP statuses and bounds.
// It must not know signing, seller selection policy or the default index URL (config owns that).

export const DISCOVERY_ERROR_CODES = {
  INVALID_INPUT: 'DISCOVERY_INVALID_INPUT',
  INSECURE_URL: 'DISCOVERY_INSECURE_URL',
  NETWORK: 'DISCOVERY_NETWORK_FAILED',
  TIMEOUT: 'DISCOVERY_TIMEOUT',
  CANCELLED: 'DISCOVERY_CANCELLED',
  RESPONSE_TOO_LARGE: 'DISCOVERY_RESPONSE_TOO_LARGE',
  MALFORMED_RESPONSE: 'DISCOVERY_MALFORMED_RESPONSE',
  INVALID_QUERY: 'DISCOVERY_INVALID_QUERY',
  INVALID_RECORD: 'DISCOVERY_INVALID_RECORD',
  INVALID_SIGNATURE: 'DISCOVERY_INVALID_SIGNATURE',
  EXPIRED_RECORD: 'DISCOVERY_EXPIRED_RECORD',
  UNKNOWN_CATALOG: 'DISCOVERY_UNKNOWN_CATALOG',
  STALE_RECORD: 'DISCOVERY_STALE_RECORD',
  PUBLISH_NOT_ALLOWED: 'DISCOVERY_PUBLISH_NOT_ALLOWED',
  RECORD_REJECTED: 'DISCOVERY_RECORD_REJECTED',
  PAYLOAD_TOO_LARGE: 'DISCOVERY_PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'DISCOVERY_RATE_LIMITED',
  UNAVAILABLE: 'DISCOVERY_UNAVAILABLE',
  HTTP_STATUS: 'DISCOVERY_HTTP_STATUS',
} as const;

export type DiscoveryErrorCode =
  (typeof DISCOVERY_ERROR_CODES)[keyof typeof DISCOVERY_ERROR_CODES];

// Static `error` values sent by the index (contract v1); external wire identifiers.
export const INDEX_WIRE_ERRORS = {
  INVALID_RECORD: 'INVALID_RECORD',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  EXPIRED_RECORD: 'EXPIRED_RECORD',
  UNKNOWN_CATALOG: 'UNKNOWN_CATALOG',
  STALE_RECORD: 'STALE_RECORD',
  // The index refuses plain http; reachable only through a loopback http base URL.
  HTTPS_REQUIRED: 'HTTPS_REQUIRED',
} as const;

export const INDEX_ERROR_MAP: ReadonlyMap<string, DiscoveryErrorCode> = new Map(
  [
    [INDEX_WIRE_ERRORS.INVALID_RECORD, DISCOVERY_ERROR_CODES.INVALID_RECORD],
    [
      INDEX_WIRE_ERRORS.INVALID_SIGNATURE,
      DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    ],
    [INDEX_WIRE_ERRORS.EXPIRED_RECORD, DISCOVERY_ERROR_CODES.EXPIRED_RECORD],
    [INDEX_WIRE_ERRORS.UNKNOWN_CATALOG, DISCOVERY_ERROR_CODES.UNKNOWN_CATALOG],
    [INDEX_WIRE_ERRORS.STALE_RECORD, DISCOVERY_ERROR_CODES.STALE_RECORD],
    [INDEX_WIRE_ERRORS.HTTPS_REQUIRED, DISCOVERY_ERROR_CODES.INSECURE_URL],
  ],
);

export const DISCOVERY_PATHS = {
  records: '/records',
  sellers: '/sellers',
} as const;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
} as const;

// Statuses mapped to one code whatever the body says; the body is never read for these.
export const STATUS_ERROR_MAP: ReadonlyMap<number, DiscoveryErrorCode> =
  new Map([
    [HTTP_STATUS.CONFLICT, DISCOVERY_ERROR_CODES.STALE_RECORD],
    [HTTP_STATUS.PAYLOAD_TOO_LARGE, DISCOVERY_ERROR_CODES.PAYLOAD_TOO_LARGE],
    [HTTP_STATUS.TOO_MANY_REQUESTS, DISCOVERY_ERROR_CODES.RATE_LIMITED],
    [HTTP_STATUS.SERVICE_UNAVAILABLE, DISCOVERY_ERROR_CODES.UNAVAILABLE],
  ]);

// Publishing adds `403 PUBLISH_NOT_ALLOWED`: the index does not accept this NodeId as a
// publisher (an allowlist). Reads keep the shared map, so a 403 there stays HTTP_STATUS.
export const PUBLISH_STATUS_ERROR_MAP: ReadonlyMap<number, DiscoveryErrorCode> =
  new Map([
    ...STATUS_ERROR_MAP,
    [HTTP_STATUS.FORBIDDEN, DISCOVERY_ERROR_CODES.PUBLISH_NOT_ALLOWED],
  ]);

export const DISCOVERY_LIMITS = {
  // Sellers response cap (index caps at about 1 MiB) plus headroom for JSON framing.
  maxSellersResponseBytes: 1_100_000,
  maxPublishResponseBytes: 4_096,
  // A canonical public v2 record may reach 32 KiB; 2 KiB more covers the envelope (same cap as the index).
  maxPublishBodyBytes: 34_816,
  defaultSellers: 50,
  maxSellers: 200,
  maxCursorCharacters: 512,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 120_000,
} as const;
