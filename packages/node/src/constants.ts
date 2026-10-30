// Seller node lifecycle states and the local role-config schema version. Values only; no wallet,
// network or process actions.
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';

export const NODE_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
} as const;
export type NodeState = (typeof NODE_STATES)[keyof typeof NODE_STATES];

// Schema of role config files in the local home; independent of the offer wire schema.
export const ROLE_CONFIG_SCHEMA_VERSION = 1;

export const TOKENIZER_ORIGIN = 'https://huggingface.co';
export const TOKENIZER_DOWNLOAD_TIMEOUT_MS = 60_000;
// Per artifact, measured on the decoded response stream rather than Content-Length.
export const TOKENIZER_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export const NODE_ERROR_CODES = {
  TOKENIZER_DOWNLOAD_FAILED: 'TOKENIZER_DOWNLOAD_FAILED',
  TOKENIZER_DOWNLOAD_TOO_LARGE: 'TOKENIZER_DOWNLOAD_TOO_LARGE',
  INVALID_ROLE_CONFIGURATION: 'INVALID_ROLE_CONFIGURATION',
  INVALID_OFFER_TRUST: 'INVALID_OFFER_TRUST',
  INVALID_SIGNED_OFFER: 'INVALID_SIGNED_OFFER',
  LEGACY_LOCAL_LAYOUT: 'LEGACY_LOCAL_LAYOUT',
  PUBLIC_SEQUENCE_UNAVAILABLE: 'PUBLIC_SEQUENCE_UNAVAILABLE',
  IDENTITY_STATE_UNAVAILABLE: 'IDENTITY_STATE_UNAVAILABLE',
  DISCOVERY_PUBLISH_FAILED: 'DISCOVERY_PUBLISH_FAILED',
  INVALID_PRICE: 'INVALID_PRICE',
  RECEIPT_STORAGE_UNAVAILABLE: 'RECEIPT_STORAGE_UNAVAILABLE',
  // gyblos.toml at seller startup; `pnpm gyblos config validate` explains file problems.
  NODE_CONFIG_INVALID: 'NODE_CONFIG_INVALID',
  SELLER_SETTING_UNSUPPORTED: 'SELLER_SETTING_UNSUPPORTED',
  SELLER_OFFER_MODEL_UNSUPPORTED: 'SELLER_OFFER_MODEL_UNSUPPORTED',
  SELLER_OFFER_ENGINE_UNSUPPORTED: 'SELLER_OFFER_ENGINE_UNSUPPORTED',
  SELLER_OFFER_REASONING_UNSUPPORTED: 'SELLER_OFFER_REASONING_UNSUPPORTED',
  // The variable an offer's api_key_env names is unset or empty.
  SELLER_OFFER_API_KEY_MISSING: 'SELLER_OFFER_API_KEY_MISSING',
  // api_key_env names a Gyblos variable or the relay token's, which must never go to a provider.
  SELLER_OFFER_API_KEY_UNSAFE: 'SELLER_OFFER_API_KEY_UNSAFE',
  SELLER_OFFERS_MISSING: 'SELLER_OFFERS_MISSING',
  SELLER_PAID_EXECUTION_UNAVAILABLE: 'SELLER_PAID_EXECUTION_UNAVAILABLE',
  // A paid offer whose usage cannot be recounted with the model's pinned public tokenizer.
  SELLER_PAID_METERING_UNRECOUNTED: 'SELLER_PAID_METERING_UNRECOUNTED',
  // The payment server pays to its own fee payer, charges another fee or uses another network.
  SELLER_PAYMENT_DESCRIPTION_INVALID: 'SELLER_PAYMENT_DESCRIPTION_INVALID',
  // A paid offer on a seller role set up without a payout and payment keys.
  SELLER_PAYMENT_ROLE_MISSING: 'SELLER_PAYMENT_ROLE_MISSING',
} as const;
export type NodeErrorCode =
  (typeof NODE_ERROR_CODES)[keyof typeof NODE_ERROR_CODES];

// `gyblos doctor` check names and static result codes; startup codes are reused verbatim.
export const DOCTOR_CHECKS = {
  CONFIG: 'config',
  HOME: 'home',
  ROLE: 'role',
  KEYS: 'keys',
  SEQUENCE: 'sequence',
  TOKENIZER: 'tokenizer',
  ENGINE: 'engine',
  RELAYS: 'relays',
  // Only for a seller with paid offers.
  PAYMENTS: 'payments',
} as const;
export type DoctorCheckName =
  (typeof DOCTOR_CHECKS)[keyof typeof DOCTOR_CHECKS];
export const DOCTOR_STATUS = { OK: 'OK', WARN: 'WARN', FAIL: 'FAIL' } as const;
export type DoctorStatus = (typeof DOCTOR_STATUS)[keyof typeof DOCTOR_STATUS];
export const DOCTOR_CODES = {
  READY: 'READY',
  ROLE_MISSING: 'ROLE_MISSING',
  ROLE_NOT_SELLER: 'ROLE_NOT_SELLER',
  KEYS_MISSING: 'KEYS_MISSING',
  KEY_PERMISSIONS: 'KEY_PERMISSIONS',
  SEQUENCE_LOCK_PRESENT: 'SEQUENCE_LOCK_PRESENT',
  TOKENIZER_UNAVAILABLE: 'TOKENIZER_UNAVAILABLE',
  NOT_CHECKED: 'NOT_CHECKED',
  // Every offer's usage is declared by its provider, so no tokenizer is loaded.
  NOT_NEEDED: 'NOT_NEEDED',
  // A remote engine is called only with --online.
  REMOTE_ENGINE_NOT_CHECKED: 'REMOTE_ENGINE_NOT_CHECKED',
  CHECK_FAILED: 'DOCTOR_CHECK_FAILED',
} as const;
export type DoctorCode = (typeof DOCTOR_CODES)[keyof typeof DOCTOR_CODES];

// Iroh secret key length stored in a role's node.key.
export const NODE_KEY_BYTES = 32;
export const NODE_CONFIGURATION_LIMITS = {
  stringCharacters: 2048,
  nodeIdHexCharacters: 64,
} as const;

export const PUBLIC_SEQUENCE = { schemaVersion: 1, maxBytes: 2048 } as const;

export const SELLER_PUBLIC_RECORDS = {
  catalogMs: 60_000,
  renewBeforeMs: 20_000,
} as const;

// Paid settlement: how long a terminal waits for the claim (well under the 180 s request deadline,
// which also covers generation), and the backoff for claims reported pending. The schedule ends well
// within a channel's lifetime, so a claim never outlives the payer's authorization unnoticed.
export const PAID_SETTLEMENT = {
  waitMs: 20_000,
  // Front-loaded into the channel's claim window (about two minutes), after which a claim lapses.
  retryDelaysMs: [2_000, 5_000, 10_000, 20_000, 40_000],
} as const;
// Claim failures a later attempt with the same charge may overcome.
export const PAID_RETRYABLE_PAYMENT_CODES: readonly string[] = [
  PAYMENT_ERROR_CODES.UNAVAILABLE,
  PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
];

export const SELLER_PUBLICATION_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  DEGRADED: 'degraded',
  STOPPED: 'stopped',
} as const;
export type SellerPublicationState =
  (typeof SELLER_PUBLICATION_STATES)[keyof typeof SELLER_PUBLICATION_STATES];

// Private engine observations; values preserve the startup diagnostic record contract.
export const READINESS_STATUSES = {
  PASSED: 'passed',
  FAILED: 'failed',
} as const;
export const READINESS_REASONS = {
  READY: 'ready',
  MEMORY_OBSERVATION_FAILED: 'memory-observation-failed',
  INSUFFICIENT_HEADROOM: 'insufficient-headroom',
  WARMUP_FAILED: 'warmup-failed',
  WARMUP_TIMEOUT: 'warmup-timeout',
} as const;

// gyblos.toml (GYB-DOC-026): schema version, closed vocabularies, bounds and static issue codes. The
// file never holds secrets; it names environment variables instead.
export const NODE_CONFIG_VERSION = 1;
export const NODE_CONFIG_FILENAME = 'gyblos.toml';

// Mainnet is recognized only so the validator can refuse it with a specific code.
export const NODE_NETWORKS = { DEVNET: 'devnet', MAINNET: 'mainnet' } as const;
export type NodeNetwork = (typeof NODE_NETWORKS)[keyof typeof NODE_NETWORKS];

export const OFFER_CURRENCIES = { USDC: 'USDC' } as const;
export type OfferCurrency =
  (typeof OFFER_CURRENCIES)[keyof typeof OFFER_CURRENCIES];

// Docker Desktop's alias for the host; like loopback, it may serve a local engine over plain HTTP.
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

// Declared metering reserves a prompt's UTF-8 bytes (never fewer than its tokens) plus room for the
// provider's chat template, which the seller cannot see. A provider that counts more input than that is
// not charged the difference. Tokens are assumed no longer than maxTokenBytes on average (a heuristic:
// some vocabularies hold longer whitespace or rule tokens), so text of that many bytes per token is a
// floor the provider's output count must reach and a bound a stream must stay within.
export const FREE_METERING = {
  declaredTemplateTokens: 64,
  declaredMaxTokenBytes: 32,
} as const;

export const NODE_CONFIG_LIMITS = {
  fileBytes: 64 * 1024,
  maxDepth: 8,
  maxOffers: 32,
  maxRelays: 8,
  envNameCharacters: 128,
  upstreamModelCharacters: 256,
  // A remote engine's context size, which its API does not report (gyblos.toml engine.context_tokens).
  minContextTokens: 1_024,
  maxContextTokens: 2_000_000,
  // Price per million tokens: at most 9999 USDC, with USDC's 6 decimal places once trailing zeros are dropped.
  priceIntegerDigits: 4,
  priceFractionDigits: 6,
  maxTokenCap: 1_000_000_000_000,
  maxPort: 65_535,
  // Unknown keys are named in an issue path only when they look like ordinary identifiers.
  echoedKeyCharacters: 64,
  // A name at least this long with a digit-bearing alphanumeric run of tokenRunCharacters looks like a
  // pasted credential: refused as an env name, redacted as an echoed key.
  tokenLikeCharacters: 24,
  tokenRunCharacters: 16,
} as const;

// Hard ceilings for gyblos.toml [limits], so a typo cannot let one seller exhaust its machine. Every
// value must be at least 1; omitted keys keep TRANSPORT_LIMITS and FREE_EXECUTION_ADMISSION.
export const SELLER_LIMIT_CEILINGS = {
  maxConnections: 64,
  requestsPerMinute: 120,
  globalRequestsPerMinute: 1024,
  maxFreeBuyersPerDay: 65_536,
} as const;

// gyblos.toml prices are USDC per million tokens; protocol v2 will charge atomic units (10^-6 USDC) per
// million tokens, so the conversion is exact.
export const USDC_ATOMIC_UNITS_PER_USDC = 1_000_000n;

export const NODE_CONFIG_ISSUE_CODES = {
  TOML_SYNTAX: 'TOML_SYNTAX',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_UNREADABLE: 'FILE_UNREADABLE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  MISSING_KEY: 'MISSING_KEY',
  WRONG_TYPE: 'WRONG_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  MAINNET_UNSUPPORTED: 'MAINNET_UNSUPPORTED',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_URL: 'INVALID_URL',
  INSECURE_URL: 'INSECURE_URL',
  INVALID_ENV_NAME: 'INVALID_ENV_NAME',
  INLINE_SECRET: 'INLINE_SECRET',
  DUPLICATE_VALUE: 'DUPLICATE_VALUE',
  TOO_MANY: 'TOO_MANY',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  CUSTOM_MODEL_IN_CATALOG: 'CUSTOM_MODEL_IN_CATALOG',
  NON_CANONICAL_DECIMAL: 'NON_CANONICAL_DECIMAL',
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',
  PRICE_ZERO: 'PRICE_ZERO',
  PRICING_CONFLICT: 'PRICING_CONFLICT',
  PRICING_MISSING: 'PRICING_MISSING',
  INVALID_CAP: 'INVALID_CAP',
  RELAY_ONLY_CONFLICT: 'RELAY_ONLY_CONFLICT',
  // A [limits] value outside its range, or a request budget that cannot cover every connection.
  INVALID_LIMIT: 'INVALID_LIMIT',
  // A catalog model with verified levels (protocol MODEL_CATALOG) does not support the listed level.
  REASONING_UNSUPPORTED: 'REASONING_UNSUPPORTED',
} as const;
export type NodeConfigIssueCode =
  (typeof NODE_CONFIG_ISSUE_CODES)[keyof typeof NODE_CONFIG_ISSUE_CODES];

export const NODE_CONFIG_WARNING_CODES = {
  // A switch variable holds something other than 1 or 0; today's reader treats it as off.
  ENV_SWITCH_NOT_STRICT: 'ENV_SWITCH_NOT_STRICT',
  // An offer's reasoning levels cannot be checked: a custom model or a catalog model without verified levels.
  REASONING_UNVERIFIED: 'REASONING_UNVERIFIED',
} as const;
export type NodeConfigWarningCode =
  (typeof NODE_CONFIG_WARNING_CODES)[keyof typeof NODE_CONFIG_WARNING_CODES];

// Precedence, highest first: CLI flags, GYBLOS_* environment, gyblos.toml, built-in defaults.
export const NODE_CONFIG_SOURCES = {
  FLAG: 'flag',
  ENV: 'env',
  FILE: 'file',
  DEFAULT: 'default',
} as const;
export type NodeConfigSource =
  (typeof NODE_CONFIG_SOURCES)[keyof typeof NODE_CONFIG_SOURCES];

export const NODE_SETTINGS = {
  NETWORK: 'network',
  HOME: 'home',
  RPC_URL: 'rpcUrl',
  PAYOUT_WALLET: 'payoutWallet',
  RELAY_URLS: 'relayUrls',
  RELAY_TOKEN_ENV: 'relayTokenEnv',
  RELAY_ONLY: 'relayOnly',
  IROH_BIND: 'irohBind',
  IROH_EXTERNAL_ADDRESS: 'irohExternalAddress',
  BUYER_RELAY_ONLY: 'buyerRelayOnly',
  DISCOVERY_PUBLISH: 'discoveryPublish',
  DISCOVERY_URL: 'discoveryUrl',
  TELEMETRY_FILE: 'telemetryFile',
  OFFERS: 'offers',
} as const;
export type NodeSettingKey = (typeof NODE_SETTINGS)[keyof typeof NODE_SETTINGS];

// Future CLI flag spellings for each overridable setting; the resolver names them in explanations.
export const NODE_CONFIG_FLAGS = {
  home: '--home',
  rpcUrl: '--rpc-url',
  payoutWallet: '--payout-wallet',
  relayUrls: '--relay',
  relayOnly: '--relay-only',
  irohBind: '--iroh-bind',
  irohExternalAddress: '--iroh-external-addr',
  buyerRelayOnly: '--buyer-relay-only',
  discoveryPublish: '--discovery-publish',
  discoveryUrl: '--discovery-url',
} as const;

// Durable identity floors are never evicted; full stores fail closed.
export const IDENTITY_STATE = {
  schemaVersion: 1,
  maxRows: 1024,
  maxBytes: 1024 * 1024,
} as const;

// Receipt retention and best-effort work are bounded independently from inference and payment state.
export const RECEIPT_STORAGE = {
  schemaVersion: 1,
  maxEntries: 256,
  maxBytes: 1_048_576,
  retentionMs: 604_800_000,
} as const;
export const RECEIPT_WORK = {
  sellerMs: 500,
  buyerMs: 2000,
  retryMs: 40,
  attempts: 3,
} as const;

// Startup owns only its configured file sink and bounds shutdown independently of inference.
export const LOCAL_TELEMETRY = { closeMs: 5000 } as const;
