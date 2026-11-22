// Owns the discovery index's canonical values: wire error codes, statuses, routes, limits and binding names.
// It must not hold record formats or signing domains (protocol owns those) or operator URLs (config).
import { LOOPBACK_HOST_NAMES } from '@gyblos/config/hosts';
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
  // POST /v1/identity/github: a malformed body or claim, or one issued too far ahead of the index's
  // clock; a claim not newer than the stored one or older than GITHUB_CLAIM.maxAgeMs; a NodeId with
  // neither an active registration nor a stored catalog.
  INVALID_CLAIM: 'INVALID_CLAIM',
  STALE_CLAIM: 'STALE_CLAIM',
  UNKNOWN_NODE: 'UNKNOWN_NODE',
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
  UPTIME: '/v1/uptime',
  VERSIONS: '/v1/versions',
  NETWORK: '/v1/network',
  // POST a signed GitHub claim here; GET `${GITHUB_IDENTITY}/<nodeId>` reads one.
  GITHUB_IDENTITY: '/v1/identity/github',
} as const;
// Public reads are CORS-readable on every status, errors included.
export const PUBLIC_READ_ROUTES: ReadonlySet<string> = new Set([
  INDEX_ROUTES.SELLERS,
  INDEX_ROUTES.MODELS,
  INDEX_ROUTES.HEALTH,
  INDEX_ROUTES.UPTIME,
  INDEX_ROUTES.VERSIONS,
  INDEX_ROUTES.NETWORK,
]);
// Public reads below a prefix (GET /v1/identity/github/<nodeId>), CORS-readable like the routes above.
export const PUBLIC_READ_PREFIXES: readonly string[] = [
  `${INDEX_ROUTES.GITHUB_IDENTITY}/`,
];

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
  // Atomic cap on tracked NodeIds, checked while a new NodeId is admitted. NodeIds are free
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
} as const;

// Cloudflare rate-limit binding names (wrangler.jsonc); keyed by IP(/64), never stored,
// except READ, keyed by READ_LIMIT_KEY.
export const DISCOVERY_LIMITERS = {
  IP: 'DISCOVERY_IP_LIMITER',
  PUBLISH: 'DISCOVERY_PUBLISH_LIMITER',
  READ: 'DISCOVERY_READ_LIMITER',
} as const;
export type DiscoveryLimiterName =
  (typeof DISCOVERY_LIMITERS)[keyof typeof DISCOVERY_LIMITERS];

// Accepted publications per NodeId and fixed UTC minute, shared atomically in storage.
export const NODE_PUBLISH_QUOTA = { limit: 10, windowMs: 60_000 } as const;

// Key for the read limiter. Cloudflare counts per location, so this caps storage reads per
// Cloudflare location, not exactly worldwide.
export const READ_LIMIT_KEY = 'global';

export const DISCOVERY_DB_BINDING = 'DISCOVERY_DB';

export const DISCOVERY_LISTING_INDEXES = {
  CATALOG: 'discovery_catalogs_listing',
  PRESENCE: 'discovery_presence_listing',
  WITHDRAWAL: 'discovery_withdrawals_listing',
} as const;
export type DiscoveryListingIndex =
  (typeof DISCOVERY_LISTING_INDEXES)[keyof typeof DISCOVERY_LISTING_INDEXES];

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
const REGISTRATION_TEXT_LIMITS = {
  inviteHashCharacters: 64,
  maxContactCharacters: 128,
  countryCharacters: 2,
} as const;
export const REGISTRATION = {
  ...REGISTRATION_TEXT_LIMITS,
  invitePrefix: INVITE_PREFIX,
  invite: new RegExp(`^${INVITE_PREFIX}[a-z2-7]{26}$`),
  inviteBytes: 16,
  nodeId: PUBLISH_ALLOWLIST.nodeId,
  country: new RegExp(`^[A-Z]{${REGISTRATION_TEXT_LIMITS.countryCharacters}}$`),
  maxBodyBytes: 512,
  dayMs: 24 * 60 * 60 * 1000,
  inviteLifetimeMs: 14 * 24 * 60 * 60 * 1000,
  maxInviteDays: 90,
  contact: new RegExp(
    `^[A-Za-z0-9@._+-]{1,${REGISTRATION_TEXT_LIMITS.maxContactCharacters}}$`,
  ),
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

// Loopback-only development counters (never used by the Worker entry).
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
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(LOOPBACK_HOST_NAMES);
// Public seller uptime (uptime.ts): five-minute slots, kept for the longest reported window.
export const UPTIME = {
  // Five minutes.
  slotMs: 300_000,
  hourMs: 3_600_000,
  slotsPerHour: 12,
  // Windows reported, in days.
  windowDays: [1, 7, 30],
  // How long hourly rows are kept: the full history for network metrics, independent of the
  // reported windows. A row with its index costs about 160 bytes, about 1.4 MB per always-online
  // NodeId per year, in the same D1 database as records (docs/discovery-index.md, Uptime).
  retentionDays: 3650,
  dayMs: 86_400_000,
  // Old rows are pruned at most once an hour per app instance.
  pruneIntervalMs: 3_600_000,
  // Ratios are rounded to four decimals.
  ratioScale: 10_000,
} as const;

// GET /v1/network (network.ts): every seller the index knows and whether it is online now.
export const NETWORK = {
  // Rows read per source (registrations, sightings, stored catalogs); the tracked-NodeId cap.
  maxNodes: DISCOVERY_INDEX_LIMITS.maxNodes,
  // Model rows read for the sellers online now (at most 64 per catalog).
  maxModelRows: 20_000,
  // Bytes reserved for the counts and framing around the node entries.
  framingBytes: 256,
} as const;
export const NETWORK_STATES = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNPUBLISHED: 'unpublished',
} as const;
export type NetworkState = (typeof NETWORK_STATES)[keyof typeof NETWORK_STATES];

// Seller GitHub claims (github-claims.ts): a node-signed claim names an account and a public gist; the
// index reads the gist's raw text at the account's own URL, which answers only when that account owns
// the gist, and looks for the NodeId's proof line. No GitHub API, token or redirect is used.
export const GITHUB_CLAIM_STATES = {
  // Not proven yet: the last check found no proof, or none has finished.
  PENDING: 'pending',
  VERIFIED: 'verified',
  // Proven before; the last conclusive check found the proof gone.
  LOST: 'lost',
} as const;
export type GithubClaimState =
  (typeof GITHUB_CLAIM_STATES)[keyof typeof GITHUB_CLAIM_STATES];
// Static outcome codes of a gist check. Only the first two are ever stored; an outage keeps the state.
export const GITHUB_CLAIM_REASONS = {
  // Any status but 200, 403, 429, 451 or 5xx, redirects included (a renamed account redirects): no
  // such gist, or the account does not own it.
  GIST_NOT_FOUND: 'GIST_NOT_FOUND',
  // The gist exists but its first GITHUB_CLAIM.maxGistBytes hold no proof line for the NodeId.
  NODE_ID_MISSING: 'NODE_ID_MISSING',
  // 403, 429, 451, 5xx, a timeout or a network error: inconclusive. 403 and 429 are GitHub limiting
  // the index; 451 is a legal block that may apply only where the request ran. Stored only on a
  // pending claim; a verified or lost claim keeps its own reason.
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  // POST answer only: the NodeId's gist was fetched less than GITHUB_CLAIM.minFetchIntervalMs ago, so
  // the claim was stored unchecked and is due for the next scheduled run; see `retryAfter`.
  CHECK_DEFERRED: 'CHECK_DEFERRED',
} as const;
export type GithubClaimReason =
  (typeof GITHUB_CLAIM_REASONS)[keyof typeof GITHUB_CLAIM_REASONS];
// The reasons a stored claim can carry.
export const STORED_GITHUB_CLAIM_REASONS = [
  GITHUB_CLAIM_REASONS.GIST_NOT_FOUND,
  GITHUB_CLAIM_REASONS.NODE_ID_MISSING,
  GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE,
] as const;
export type StoredGithubClaimReason =
  (typeof STORED_GITHUB_CLAIM_REASONS)[number];
export const GITHUB_CLAIM = {
  // A signed claim is a few hundred bytes.
  maxBodyBytes: 1024,
  // How old a claim may be when it arrives. A cancel keeps the NodeId's newest issuedAt, so an older
  // signed claim is never replayed; this also bounds a claim's delivery delay.
  maxAgeMs: 60_000,
  gistOrigin: 'https://gist.githubusercontent.com',
  fetchTimeoutMs: 3000,
  maxGistBytes: 16_384,
  // At most one gist fetch per NodeId per interval from POSTs, reserved atomically in storage.
  minFetchIntervalMs: 60_000,
  // The scheduled run checks claims whose next check is due, at most `recheckBatch` per run, and
  // schedules the next one this long after a check.
  recheckAfterMs: 6 * 60 * 60 * 1000,
  recheckBatch: 25,
  // A claim still pending this long after it was issued, never verified, is no longer rechecked by the
  // scheduled run; it stays readable and a new POST checks it again.
  abandonPendingAfterMs: 7 * 24 * 60 * 60 * 1000,
  // Statuses of the raw gist URL: 200 is read; these and 5xx are inconclusive; any other is not found.
  found: 200,
  inconclusive: [403, 429, 451],
  serverError: 500,
  msPerSecond: 1000,
} as const;
