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
export const SELLER_SELECTION_POLICY = {
  defaultCandidates: 3,
  maxCandidates: 5,
  maxSellers: 4096,
  // Free or near-free offers weigh as if priced at this fraction of the cheapest paid survivor.
  freePriceFraction: 0.5,
  // An open payment channel makes a seller look this much cheaper (no new deposit rent).
  openChannelPriceFactor: 0.8,
  reputationMin: 0.25,
  reputationMax: 2,
  latencyReferenceMs: 1000,
  latencyFactorMin: 0.5,
  latencyFactorMax: 1.5,
  successFactorBase: 0.5,
  waitFactorBase: 0.5,
} as const;
