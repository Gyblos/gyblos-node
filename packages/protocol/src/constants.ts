// Owns canonical shared protocol codes, engine completion reasons, offer and public-record wire ids.
// These are wire strings: changing one breaks peers. No SDK dependencies.
export const PROTOCOL_ERROR_CODES = {
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  BAD_USAGE: 'BAD_USAGE',
  BUYER_BUSY: 'BUYER_BUSY',
  BUYER_DELTA: 'BUYER_DELTA',
  BUYER_GAS: 'BUYER_GAS',
  CHANNEL_NOT_DISTRIBUTED: 'CHANNEL_NOT_DISTRIBUTED',
  INSUFFICIENT_EXACT_USDC: 'INSUFFICIENT_EXACT_USDC',
  INSUFFICIENT_INFERENCE_ESCROW: 'INSUFFICIENT_INFERENCE_ESCROW',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  MISSING_TRANSACTIONS: 'MISSING_TRANSACTIONS',
  NEEDS_CIRCLE_USDC: 'NEEDS_CIRCLE_USDC',
  NEEDS_SOL: 'NEEDS_SOL',
  NEEDS_TOKENS: 'NEEDS_TOKENS',
  NO_PUBLIC_FACILITATOR: 'NO_PUBLIC_FACILITATOR',
  PAID_REQUEST_FAILED: 'PAID_REQUEST_FAILED',
  PORT_BUSY: 'PORT_BUSY',
  PROGRAM_UNAVAILABLE: 'PROGRAM_UNAVAILABLE',
  PUBLIC_OUTCOME_UNCERTAIN: 'PUBLIC_OUTCOME_UNCERTAIN',
  PUBLIC_PROVIDERS_REJECTED: 'PUBLIC_PROVIDERS_REJECTED',
  RPC_ERROR: 'RPC_ERROR',
  RPC_HTTP: 'RPC_HTTP',
  SELLER_DELTA: 'SELLER_DELTA',
  SUPPORT_CHANGED: 'SUPPORT_CHANGED',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  TRANSACTION_UNKNOWN: 'TRANSACTION_UNKNOWN',
  UNCONFIRMED_INFERENCE_DEPOSIT: 'UNCONFIRMED_INFERENCE_DEPOSIT',
  UNRESOLVED_ATTEMPT: 'UNRESOLVED_ATTEMPT',
  UNRESOLVED_EXACT: 'UNRESOLVED_EXACT',
  UNSUPPORTED_TOKEN_INSTRUCTION: 'UNSUPPORTED_TOKEN_INSTRUCTION',
  UNTRUSTED_EXACT_TERMS: 'UNTRUSTED_EXACT_TERMS',
  UNTRUSTED_RECEIPT: 'UNTRUSTED_RECEIPT',
  UNTRUSTED_TERMS: 'UNTRUSTED_TERMS',
  WRONG_CLUSTER: 'WRONG_CLUSTER',
} as const;

export const ENGINE_DONE_REASONS = {
  STOP: 'stop',
  LENGTH: 'length',
} as const;

export type EngineDoneReason =
  (typeof ENGINE_DONE_REASONS)[keyof typeof ENGINE_DONE_REASONS];

export type ProtocolErrorCode =
  (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

// Iroh ALPN for the seller's HTTP-over-QUIC stream; also the offer's `protocol` field.
export const GYBLOS_ALPN = 'gyblos/http/1';

// Signed private inference offer: domain prefix (real LF) and payload schema version.
export const OFFER_DOMAIN = 'gyblos/signed-inference-offer/v1\n';
export const OFFER_SCHEMA_VERSION = 1;

export const PUBLIC_RECORD_KINDS = {
  CATALOG: 'catalog',
  PRESENCE: 'presence',
  WITHDRAWAL: 'withdrawal',
} as const;

export const PUBLIC_RECORD_DOMAINS = {
  [PUBLIC_RECORD_KINDS.CATALOG]: 'gyblos/catalog/v1\n',
  [PUBLIC_RECORD_KINDS.PRESENCE]: 'gyblos/presence/v1\n',
  [PUBLIC_RECORD_KINDS.WITHDRAWAL]: 'gyblos/withdrawal/v1\n',
} as const satisfies Record<PublicRecordKind, string>;

export const PUBLIC_RECORD_LIMITS = {
  schemaVersion: 1,
  maxModels: 64,
  maxIdentifierCharacters: 128,
  maxAtomicDigits: 20,
  maxAtomic: '18446744073709551615',
  maxContextTokens: 10_000_000,
  catalogLifetimeMs: 600_000,
  presenceLifetimeMs: 90_000,
  withdrawalLifetimeMs: 600_000,
  suggestedHeartbeatMs: 30_000,
  publicKeyBytes: 32,
  signatureBytes: 64,
  hexCharactersPerByte: 2,
  maxAddressCharacters: 44,
  minAddressCharacters: 32,
  maxWireBytes: 32_768,
} as const;

export const PUBLIC_RECORD_ERROR_CODES = {
  INVALID_RECORD: 'INVALID_PUBLIC_RECORD',
  INVALID_SIGNATURE: 'INVALID_PUBLIC_SIGNATURE',
  UNTRUSTED_IDENTITY: 'UNTRUSTED_PUBLIC_IDENTITY',
  INVALID_TIME: 'INVALID_PUBLIC_TIME',
  STALE_SEQUENCE: 'STALE_PUBLIC_SEQUENCE',
  INVALID_REFERENCE: 'INVALID_CATALOG_REFERENCE',
} as const;

export const DATA_RETENTION = {
  NONE: 'none',
  MAY_RETAIN: 'may-retain',
  UNSPECIFIED: 'unspecified',
} as const;

export const PUBLIC_PRESENCE_STATE = 'alive';
export const PUBLIC_PRICE_UNIT = 'token';
export const V2_PRICING = {
  unit: 'million-tokens',
  tokensPerUnit: 1_000_000,
} as const;
export const MODEL_CLASSIFICATIONS = {
  CATALOG: 'catalog',
  CUSTOM: 'custom',
} as const;

export type PublicRecordKind =
  (typeof PUBLIC_RECORD_KINDS)[keyof typeof PUBLIC_RECORD_KINDS];
export type PublicRecordErrorCode =
  (typeof PUBLIC_RECORD_ERROR_CODES)[keyof typeof PUBLIC_RECORD_ERROR_CODES];
export type DataRetention =
  (typeof DATA_RETENTION)[keyof typeof DATA_RETENTION];

export const MODEL_IDS = {
  QWEN3_30B_A3B: 'qwen3-30b-a3b',
  QWEN3_235B_A22B: 'qwen3-235b-a22b',
  DEEPSEEK_V4_1_FLASH: 'deepseek-v4.1-flash',
  KIMI_K3: 'kimi-k3',
  GLM_5_3_FLASH: 'glm-5.3-flash',
  GPT_OSS_120B: 'gpt-oss-120b',
  GPT_OSS_20B: 'gpt-oss-20b',
  LLAMA_3_3_70B: 'llama-3.3-70b',
  GEMMA_4_26B: 'gemma-4-26b',
  QWEN3_0_6B: 'qwen3-0.6b',
} as const;

export type CatalogModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

// Control contracts are additive; HTTP v2 is reserved, never registered by this package.
export const CONTROL_ALPN = 'gyblos/control/1';
export const CONTROL_PAID_ALPN = 'gyblos/http/2';
export const CONTROL_VERSION = 1;
export const CONTROL_RECORD_VERSION = 2;
export const CONTROL_METHODS = {
  CATALOG: 'catalog.get',
  PRESENCE: 'presence.get',
  OFFER: 'offer.request',
} as const;
export const REASONING_LEVELS = {
  OFF: 'off',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
export type ReasoningLevel =
  (typeof REASONING_LEVELS)[keyof typeof REASONING_LEVELS];
export const CONTROL_CODES = {
  INVALID: 'INVALID_CONTROL_REQUEST',
  VERSION: 'UNSUPPORTED_CONTROL_VERSION',
  STALE: 'STALE_CONTROL_CATALOG',
  MODEL: 'CONTROL_MODEL_UNSUPPORTED',
  LEVEL: 'CONTROL_LEVEL_UNSUPPORTED',
  POLICY: 'CONTROL_POLICY_MISMATCH',
  BUSY: 'CONTROL_BUSY',
  LIMIT: 'CONTROL_LIMIT_EXCEEDED',
  INTERNAL: 'CONTROL_INTERNAL_ERROR',
  SIGNATURE: 'INVALID_CONTROL_SIGNATURE',
  EXPIRED: 'EXPIRED_CONTROL_RECORD',
  CANCELLED: 'CONTROL_CANCELLED',
} as const;
export type ControlCode = (typeof CONTROL_CODES)[keyof typeof CONTROL_CODES];
export const CONTROL_DOMAINS = {
  REQUEST: 'gyblos/control-request/v1\n',
  OFFER: 'gyblos/signed-inference-offer/v2\n',
} as const;
export const PUBLIC_V2_DOMAINS = {
  [PUBLIC_RECORD_KINDS.CATALOG]: 'gyblos/catalog/v2\n',
  [PUBLIC_RECORD_KINDS.PRESENCE]: 'gyblos/presence/v2\n',
  [PUBLIC_RECORD_KINDS.WITHDRAWAL]: 'gyblos/withdrawal/v2\n',
} as const satisfies Record<PublicRecordKind, string>;
export const CONTROL_LIMITS = {
  maxDirectAddresses: 16,
  requestBytes: 8192,
  responseBytes: 65536,
  depth: 16,
  prefixBytes: 4,
  requestIdBytes: 16,
  quoteLifetimeMs: 30000,
  signatureBytes: 64,
  digestBytes: 32,
} as const;
export const CONTROL_AVAILABILITY = 'ready';

export const CONTROL_METERING_MODES = {
  RECOUNTED: 'recounted',
  DECLARED: 'declared',
} as const;
export type ControlMeteringMode =
  (typeof CONTROL_METERING_MODES)[keyof typeof CONTROL_METERING_MODES];
export const MODEL_IDENTITIES = {
  DIGEST: 'digest',
  NAME_ONLY: 'name-only',
} as const;
