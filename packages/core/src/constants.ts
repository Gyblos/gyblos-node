// Inference prices, recount tolerance, offer id and lifetime, and the charge-anomaly and done-reason codes.
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

export const PRICES = { inputAtomic: '1', outputAtomic: '2' } as const;

// Fixed before measuring, applied independently to input and output counts.
export const TOLERANCE = { absoluteTokens: 2, relativePercent: 2 } as const;

export const OFFER_ID = 'qwen3-0.6b-local-v1';

// Longest issued-to-expiry window a buyer accepts; the seller signs offers with exactly this lifetime.
export const OFFER_LIFETIME_MS = 4 * 60_000;

export const CHARGE_ANOMALIES = {
  OVERCHARGE: 'overcharge',
  UNDERCHARGE: 'undercharge',
  FAILED: 'failed',
  INCOMPLETE: 'incomplete',
  NONE: 'none',
} as const;

export const OBSERVED_DONE_REASONS = {
  ...ENGINE_DONE_REASONS,
  UNKNOWN: 'unknown',
} as const;
export type ChargeAnomaly =
  (typeof CHARGE_ANOMALIES)[keyof typeof CHARGE_ANOMALIES];
export type ObservedDoneReason =
  (typeof OBSERVED_DONE_REASONS)[keyof typeof OBSERVED_DONE_REASONS];

// Proposed local control admission policy; these values do not define wire framing.
export const CONTROL_CAPACITY = {
  connections: 32,
  connectionsPerPeer: 4,
  queries: 32,
  queriesPerPeer: 4,
  globalRate: 100,
  globalBurst: 100,
  peerRate: 5,
  peerBurst: 10,
  peers: 1024,
  peerIdleMs: 60000,
  queryMs: 10000,
  connectionIdleMs: 10000,
  millisecondsPerSecond: 1000,
} as const;

// Buyer seller-selection policy (GYB-DOC-029), owned by seller-selection.ts; proposed values.
export const SELLER_SELECTION_CODES = {
  INVALID: 'INVALID_SELECTION_INPUT',
  NO_CANDIDATES: 'NO_SELLER_CANDIDATES',
  LEVEL_UNSUPPORTED: 'SELECTION_LEVEL_UNSUPPORTED',
  PINNED_REJECTED: 'PINNED_SELLER_REJECTED',
  // The pinned seller passes every filter except a local cooldown; the result carries its end.
  PINNED_IN_COOLDOWN: 'PINNED_SELLER_IN_COOLDOWN',
} as const;
export type SellerSelectionCode =
  (typeof SELLER_SELECTION_CODES)[keyof typeof SELLER_SELECTION_CODES];

// Checkability badges (GYB-DOC-001). The v2 catalog carries none, so the caller derives them.
export const SELLER_BADGES = {
  DECLARED_USAGE: 'declared-usage',
  MEASURABLE_USAGE: 'measurable-usage',
  VERIFIED_MODEL: 'verified-model',
} as const;
export type SellerBadge = (typeof SELLER_BADGES)[keyof typeof SELLER_BADGES];
// Weakest first; a minimum badge accepts every later entry.
export const SELLER_BADGE_ORDER = [
  SELLER_BADGES.DECLARED_USAGE,
  SELLER_BADGES.MEASURABLE_USAGE,
  SELLER_BADGES.VERIFIED_MODEL,
] as const satisfies readonly SellerBadge[];

// Proposed local router policy (GYB-DOC-029); tune per release, never per request.
// A caller such as the managed gateway may inject its own values of the same shape.
export const SELLER_SELECTION_POLICY = {
  defaultCandidates: 3,
  maxCandidates: 5,
  maxSellers: 4096,
  // A free offer weighs this many times the cheapest paid survivor of its tier.
  freeWeightMultiple: 2,
  // An open payment channel makes a seller look this much cheaper (no new deposit rent).
  openChannelPriceFactor: 0.8,
  // A failing seller keeps a small chance to recover, never zero.
  reputationMin: 0.03,
  reputationMax: 2,
  // Added to the smoothed success rate; 0 lets failures scale the weight down directly.
  successFactorBase: 0,
  latencyReferenceMs: 1000,
  latencyFactorMin: 0.5,
  latencyFactorMax: 1.5,
  waitFactorBase: 0.5,
  // Wait accuracy assumed without observations: neutral, not perfect.
  neutralWaitAccuracy: 0.5,
  // Pseudo-samples that shrink latency and wait factors toward neutral while history is short.
  historyPriorSamples: 5,
  // A previous seller keeps the first slot while its weight is at least this fraction of the best.
  stickyWeightFraction: 0.8,
} as const;
export type SellerSelectionPolicy = {
  readonly [Key in keyof typeof SELLER_SELECTION_POLICY]: number;
};

// Bounded free execution state for one stable configured offer.
export const FREE_EXECUTION_ADMISSION = {
  utcDayMs: 86_400_000,
  maxReplayEntries: 4096,
  maxBuyers: 1024,
  maxConcurrent: 1,
} as const;

// Paid requests: one generation at a time, like free, and request ids remembered until their quote
// expires. A paid buyer is never capped per day: each request is paid for.
export const PAID_EXECUTION_ADMISSION = {
  maxReplayEntries: 4096,
  maxConcurrent: 1,
} as const;

// Read-only identity observations and trust decisions; signatures and RPC reads belong to adapters.
export const IDENTITY_LOOKUP_KINDS = {
  BOUND: 'bound',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
} as const;
export const IDENTITY_LOOKUP_FAILURES = {
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  AMBIGUOUS: 'ambiguous',
  LIMIT: 'limit',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  NETWORK: 'network',
} as const;
export type IdentityLookupFailure =
  (typeof IDENTITY_LOOKUP_FAILURES)[keyof typeof IDENTITY_LOOKUP_FAILURES];
export const IDENTITY_TRUST_SOURCES = {
  REGISTRY: 'registry',
  MANUAL: 'manual',
} as const;
export type IdentityTrustSource =
  (typeof IDENTITY_TRUST_SOURCES)[keyof typeof IDENTITY_TRUST_SOURCES];
export const IDENTITY_POLICY_CODES = {
  INVALID: 'IDENTITY_POLICY_INVALID',
  SCOPE: 'IDENTITY_POLICY_SCOPE_MISMATCH',
  NOT_FOUND: 'IDENTITY_POLICY_NOT_FOUND',
  UNAVAILABLE: 'IDENTITY_POLICY_UNAVAILABLE',
  AMBIGUOUS: 'IDENTITY_POLICY_AMBIGUOUS',
  LIMIT: 'IDENTITY_POLICY_LIMIT',
  TIMEOUT: 'IDENTITY_POLICY_TIMEOUT',
  CANCELLED: 'IDENTITY_POLICY_CANCELLED',
  NETWORK: 'IDENTITY_POLICY_NETWORK_MISMATCH',
  OWNER_MISMATCH: 'IDENTITY_POLICY_OWNER_MISMATCH',
  OWNER_CHANGED: 'IDENTITY_POLICY_OWNER_CHANGED',
  STALE: 'IDENTITY_POLICY_STALE_BINDING',
  CONFLICT: 'IDENTITY_POLICY_BINDING_CONFLICT',
  REVOKED: 'IDENTITY_POLICY_REVOKED',
} as const;
export type IdentityPolicyCode =
  (typeof IDENTITY_POLICY_CODES)[keyof typeof IDENTITY_POLICY_CODES];
export const IDENTITY_POLICY_LIMITS = {
  maxSequence: 0xffff_ffff_ffff_ffffn,
} as const;

// First private free-receipt policy: per-instance active work, no queue or external collection.
export const RECEIPT_COLLECTOR_LIMITS = {
  bytes: 4096,
  depth: 16,
  active: 4,
} as const;
export const RECEIPT_COLLECTOR_CODES = {
  INVALID: 'COLLECTOR_INVALID',
  LIMIT: 'COLLECTOR_LIMIT',
  SIGNATURE: 'COLLECTOR_SIGNATURE',
  BINDING: 'COLLECTOR_BINDING',
  NOT_FREE: 'COLLECTOR_NOT_FREE',
  PAIR_REQUIRED: 'COLLECTOR_PAIR_REQUIRED',
  DISPUTE: 'COLLECTOR_DISPUTE',
  CONFLICT: 'COLLECTOR_CONFLICT',
  BUSY: 'COLLECTOR_BUSY',
  CANCELLED: 'COLLECTOR_CANCELLED',
  STORAGE: 'COLLECTOR_STORAGE',
} as const;
export type ReceiptCollectorCode =
  (typeof RECEIPT_COLLECTOR_CODES)[keyof typeof RECEIPT_COLLECTOR_CODES];
export const RECEIPT_COLLECTOR_WRITES = {
  INSERTED: 'inserted',
  IDENTICAL: 'identical',
  CONFLICT: 'conflict',
  FULL: 'full',
} as const;
export type ReceiptCollectorWrite =
  (typeof RECEIPT_COLLECTOR_WRITES)[keyof typeof RECEIPT_COLLECTOR_WRITES];
export const RECEIPT_COLLECTOR_STATUSES = {
  STORED: 'stored',
  DUPLICATE: 'duplicate',
} as const;
export type ReceiptCollectorStatus =
  (typeof RECEIPT_COLLECTOR_STATUSES)[keyof typeof RECEIPT_COLLECTOR_STATUSES];

// Hex radix for the private pair fingerprint, not a wire/signing domain.
export const RECEIPT_COLLECTOR_FINGERPRINT_RADIX = 16;

// Pilot ceiling in atomic units of six-decimal USDC; applies to one channel deposit.
export const MAINNET_PILOT_MAX_USDC_ATOMIC = '1000000';
