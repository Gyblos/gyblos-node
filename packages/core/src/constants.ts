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
