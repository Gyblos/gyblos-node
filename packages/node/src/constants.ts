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
