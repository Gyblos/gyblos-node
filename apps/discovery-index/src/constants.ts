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
  // POST /v1/registrations: a malformed body; an unknown, used or expired invite; a NodeId with no
  // verified 8004 registration on chain.
  INVALID_REGISTRATION: 'INVALID_REGISTRATION',
  INVITE_INVALID: 'INVITE_INVALID',
  IDENTITY_NOT_REGISTERED: 'IDENTITY_NOT_REGISTERED',
  // An operator revoked this NodeId; only the operator can readmit it (`pnpm index:restore`).
  NODE_REVOKED: 'NODE_REVOKED',
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
  MODELS: '/v1/models',
  HEALTH: '/v1/health',
  REGISTRATIONS: '/v1/registrations',
} as const;
// Public reads are CORS-readable on every status, errors included.
export const PUBLIC_READ_ROUTES: ReadonlySet<string> = new Set([
  INDEX_ROUTES.SELLERS,
  INDEX_ROUTES.MODELS,
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
  // Models listed by GET /v1/models, most sellers first.
  maxModels: 500,
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
// except READ, keyed by READ_LIMIT_KEY.
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
  // No allowlist secret, but NodeIds admitted through /v1/registrations may publish.
  REGISTERED: 'registered',
  OPEN: 'open',
} as const;

// Worker secret: a devnet Solana RPC URL the index reads the 8004 registry through. A provider key
// belongs in the URL path (query strings are refused). Missing, /v1/registrations answers 503.
export const DISCOVERY_SOLANA_RPC_BINDING = 'DISCOVERY_SOLANA_RPC_URL';

// Beta invites (vault: 20 Decisions/Alta de vendedores.md §2). The code is the prefix and 26 base32
// characters (128 random bits); only its SHA-256 is stored.
const INVITE_PREFIX = 'gyb_';
export const REGISTRATION = {
  invitePrefix: INVITE_PREFIX,
  invite: new RegExp(`^${INVITE_PREFIX}[a-z2-7]{26}$`),
  inviteBytes: 16,
  nodeId: PUBLISH_ALLOWLIST.nodeId,
  country: /^[A-Z]{2}$/,
  maxBodyBytes: 512,
  dayMs: 24 * 60 * 60 * 1000,
  inviteLifetimeMs: 14 * 24 * 60 * 60 * 1000,
  maxInviteDays: 90,
  contact: /^[A-Za-z0-9@._+-]{1,128}$/,
} as const;
// Lowercase hex of a SHA-256 digest: two characters per byte.
export const HEX = { radix: 16, byteWidth: 2 } as const;
export const REGISTRATION_STATUS = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;
export type RegistrationStatus =
  (typeof REGISTRATION_STATUS)[keyof typeof REGISTRATION_STATUS];
// What an invite can do for one NodeId: be spent, nothing (already spent on this NodeId: a retry
// succeeds while it is active and is refused as revoked after), or be refused (unknown, expired, spent
// on another NodeId).
export const INVITE_STATES = {
  USABLE: 'usable',
  ADMITTED: 'admitted',
  REVOKED: 'revoked',
  INVALID: 'invalid',
} as const;
export type InviteState = (typeof INVITE_STATES)[keyof typeof INVITE_STATES];
// Results of redeeming an invite for a NodeId.
export const REDEEM_RESULTS = {
  REGISTERED: 'registered',
  ALREADY_ACTIVE: 'already-active',
  REVOKED: 'revoked',
  INVITE_INVALID: 'invite-invalid',
} as const;
export type RedeemResult = (typeof REDEEM_RESULTS)[keyof typeof REDEEM_RESULTS];
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
