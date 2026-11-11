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
  // How far ahead of the verifier's clock a v2 record or quote may be issued. Real machines differ
  // by hundreds of milliseconds; expiry gets no grace.
  clockSkewMs: 5000,
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

// Free execution is a separate data channel; control and reserved HTTP v2 keep their wire contracts.
// Version 4 carries a whole conversation (an optional system message, then user and assistant turns,
// ending with the user's); its input is bounded by bytes here and by the model's context at the seller.
export const FREE_EXECUTION = {
  alpn: 'gyblos/free/4',
  version: 4,
  requestDomain: 'gyblos/free-execution-request/v4\n',
  requestBytes: 393216,
  responseBytes: 1048576,
  inputBytes: 262144,
  outputBytes: 262144,
  maxMessages: 64,
} as const;
export const FREE_CHAT_ROLES = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
} as const;
export type FreeChatRole =
  (typeof FREE_CHAT_ROLES)[keyof typeof FREE_CHAT_ROLES];
export const FREE_EXECUTION_CODES = {
  INVALID: 'INVALID_FREE_EXECUTION',
  VERSION: 'UNSUPPORTED_FREE_EXECUTION_VERSION',
  LIMIT: 'FREE_EXECUTION_LIMIT_EXCEEDED',
  BINDING: 'FREE_EXECUTION_BINDING_MISMATCH',
  SIGNATURE: 'INVALID_FREE_EXECUTION_SIGNATURE',
  EXPIRED: 'EXPIRED_FREE_EXECUTION_QUOTE',
  PEER: 'FREE_EXECUTION_PEER_MISMATCH',
  REPLAY: 'FREE_EXECUTION_REPLAY',
  NOT_FREE: 'FREE_EXECUTION_NOT_FREE',
  DAILY_CAP: 'FREE_EXECUTION_DAILY_CAP_EXHAUSTED',
  BUYER_CAP: 'FREE_EXECUTION_BUYER_CAP_EXHAUSTED',
  UNSUPPORTED: 'FREE_EXECUTION_UNSUPPORTED',
  BUSY: 'FREE_EXECUTION_BUSY',
  ENGINE: 'FREE_EXECUTION_ENGINE_UNAVAILABLE',
  TIMEOUT: 'FREE_EXECUTION_TIMEOUT',
  CANCELLED: 'FREE_EXECUTION_CANCELLED',
  INTERNAL: 'FREE_EXECUTION_INTERNAL_ERROR',
  // A started generation stopped on an engine failure; carries a stop reason.
  SELLER_CANNOT_CONTINUE: 'FREE_EXECUTION_SELLER_CANNOT_CONTINUE',
} as const;
export type FreeExecutionCode =
  (typeof FREE_EXECUTION_CODES)[keyof typeof FREE_EXECUTION_CODES];
// COMPLETE is a one-shot response; STREAM is the terminal after deltas the caller already verified.
export const FREE_EXECUTION_MATCH_MODES = {
  COMPLETE: 'complete',
  STREAM: 'stream',
} as const;
export type FreeExecutionMatchMode =
  (typeof FREE_EXECUTION_MATCH_MODES)[keyof typeof FREE_EXECUTION_MATCH_MODES];

export const FREE_STREAM = {
  alpn: 'gyblos/free-stream/4',
  deltaBytes: 8192,
  eventBytes: FREE_EXECUTION.responseBytes + 1024,
  // An engine may send a delta per token: room for the longest answer a context allows.
  maxEvents: 32768,
  totalBytes: FREE_EXECUTION.responseBytes * 2,
  terminalReserveBytes: 1024,
  events: { DELTA: 'delta', TERMINAL: 'terminal' },
} as const;

// Usage receipts are independently signed attestations, never execution authorization.
export const RECEIPT = {
  version: 1,
  sellerDomain: 'gyblos/receipt-seller/v1\n',
  buyerDomain: 'gyblos/receipt-buyer/v1\n',
  sellerRecordBytes: 2048,
  buyerRecordBytes: 1024,
} as const;
export const RECEIPT_OUTCOMES = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type ReceiptOutcome =
  (typeof RECEIPT_OUTCOMES)[keyof typeof RECEIPT_OUTCOMES];
export const RECEIPT_VERDICTS = {
  AGREED: 'agreed',
  DISPUTED: 'disputed',
} as const;
export type ReceiptVerdict =
  (typeof RECEIPT_VERDICTS)[keyof typeof RECEIPT_VERDICTS];
export const RECEIPT_DISPUTE_FIELDS = {
  INPUT_TOKENS: 'inputTokens',
  OUTPUT_TOKENS: 'outputTokens',
  OUTPUT_BYTES: 'outputBytes',
} as const;
export type ReceiptDisputeField =
  (typeof RECEIPT_DISPUTE_FIELDS)[keyof typeof RECEIPT_DISPUTE_FIELDS];
// Node roles, engine families and offer pricing kinds shared across layers (node composition today).
export const P2P_ROLES = { BUYER: 'buyer', SELLER: 'seller' } as const;
export type P2PRole = (typeof P2P_ROLES)[keyof typeof P2P_ROLES];

export const ENGINE_KINDS = {
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
} as const;
export type EngineKind = (typeof ENGINE_KINDS)[keyof typeof ENGINE_KINDS];

export const OFFER_PRICING_KINDS = { PAID: 'paid', FREE: 'free' } as const;
export type OfferPricingKind =
  (typeof OFFER_PRICING_KINDS)[keyof typeof OFFER_PRICING_KINDS];

// Uniform engine failures every engine adapter reports; the message is the code, never provider text.
export const ENGINE_ERROR_CODES = {
  QUOTA_EXHAUSTED: 'ENGINE_QUOTA_EXHAUSTED',
  RATE_LIMITED: 'ENGINE_RATE_LIMITED',
  AUTH: 'ENGINE_AUTH_FAILED',
  UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  INTERRUPTED: 'ENGINE_INTERRUPTED',
  TIMEOUT: 'ENGINE_TIMEOUT',
  INVALID_RESPONSE: 'ENGINE_INVALID_RESPONSE',
} as const;
export type EngineErrorCode =
  (typeof ENGINE_ERROR_CODES)[keyof typeof ENGINE_ERROR_CODES];

// Why a seller could not continue a started generation, as a buyer may see it.
export const FREE_EXECUTION_STOP_REASONS = {
  QUOTA_EXHAUSTED: 'quota_exhausted',
  RATE_LIMITED: 'rate_limited',
  ENGINE_UNAVAILABLE: 'engine_unavailable',
  ENGINE_INTERRUPTED: 'engine_interrupted',
  ENGINE_TIMEOUT: 'engine_timeout',
  ENGINE_INVALID_RESPONSE: 'engine_invalid_response',
} as const;
export type FreeExecutionStopReason =
  (typeof FREE_EXECUTION_STOP_REASONS)[keyof typeof FREE_EXECUTION_STOP_REASONS];

export const ENGINE_ERROR_STOP_REASON: Readonly<
  Record<EngineErrorCode, FreeExecutionStopReason>
> = {
  [ENGINE_ERROR_CODES.QUOTA_EXHAUSTED]:
    FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
  [ENGINE_ERROR_CODES.RATE_LIMITED]: FREE_EXECUTION_STOP_REASONS.RATE_LIMITED,
  // Credential state of the seller's upstream account is private to the seller (founder decision).
  [ENGINE_ERROR_CODES.AUTH]: FREE_EXECUTION_STOP_REASONS.ENGINE_UNAVAILABLE,
  [ENGINE_ERROR_CODES.UNAVAILABLE]:
    FREE_EXECUTION_STOP_REASONS.ENGINE_UNAVAILABLE,
  [ENGINE_ERROR_CODES.INTERRUPTED]:
    FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
  [ENGINE_ERROR_CODES.TIMEOUT]: FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT,
  [ENGINE_ERROR_CODES.INVALID_RESPONSE]:
    FREE_EXECUTION_STOP_REASONS.ENGINE_INVALID_RESPONSE,
};

// Historical usage-receipt exchange, separate from inference and payments.
export const RECEIPT_CHANNEL = {
  version: 1,
  alpn: 'gyblos/receipt/1',
  frameBytes: 8192,
} as const;
export const RECEIPT_CHANNEL_METHODS = {
  GET: 'receipt.get',
  CONFIRM: 'receipt.confirm',
} as const;
export const RECEIPT_CHANNEL_CODES = {
  INVALID: 'RECEIPT_INVALID',
  VERSION: 'RECEIPT_VERSION',
  BINDING: 'RECEIPT_BINDING',
  SIGNATURE: 'RECEIPT_SIGNATURE',
  NOT_FOUND: 'RECEIPT_NOT_FOUND',
  CONFLICT: 'RECEIPT_CONFLICT',
  BUSY: 'RECEIPT_BUSY',
  LIMIT: 'RECEIPT_LIMIT',
  CANCELLED: 'RECEIPT_CANCELLED',
  INTERNAL: 'RECEIPT_INTERNAL',
} as const;
export type ReceiptChannelCode =
  (typeof RECEIPT_CHANNEL_CODES)[keyof typeof RECEIPT_CHANNEL_CODES];

// Payment port catalogs live in their own module; re-exported so every caller keeps one import.
export * from './payments/constants';
