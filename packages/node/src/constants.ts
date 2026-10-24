// Seller node lifecycle states and the local role-config schema version. Values only; no wallet,
// network or process actions.
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
  DISCOVERY_PUBLISH_FAILED: 'DISCOVERY_PUBLISH_FAILED',
  INVALID_PRICE: 'INVALID_PRICE',
} as const;
export type NodeErrorCode =
  (typeof NODE_ERROR_CODES)[keyof typeof NODE_ERROR_CODES];

export const P2P_ROLES = { BUYER: 'buyer', SELLER: 'seller' } as const;
export type P2PRole = (typeof P2P_ROLES)[keyof typeof P2P_ROLES];
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

export const ENGINE_KINDS = {
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
} as const;
export type EngineKind = (typeof ENGINE_KINDS)[keyof typeof ENGINE_KINDS];

export const OFFER_CURRENCIES = { USDC: 'USDC' } as const;
export type OfferCurrency =
  (typeof OFFER_CURRENCIES)[keyof typeof OFFER_CURRENCIES];

export const OFFER_PRICING_KINDS = { PAID: 'paid', FREE: 'free' } as const;

// Docker Desktop's alias for the host; like loopback, it may serve a local engine over plain HTTP.
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

export const NODE_CONFIG_LIMITS = {
  fileBytes: 64 * 1024,
  maxDepth: 8,
  maxOffers: 32,
  maxRelays: 8,
  envNameCharacters: 128,
  upstreamModelCharacters: 256,
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
} as const;
export type NodeConfigIssueCode =
  (typeof NODE_CONFIG_ISSUE_CODES)[keyof typeof NODE_CONFIG_ISSUE_CODES];

export const NODE_CONFIG_WARNING_CODES = {
  // A switch variable holds something other than 1 or 0; today's reader treats it as off.
  ENV_SWITCH_NOT_STRICT: 'ENV_SWITCH_NOT_STRICT',
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
