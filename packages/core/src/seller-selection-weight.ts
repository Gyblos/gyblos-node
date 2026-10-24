// Validates the injectable selection policy and turns price plus local stats into sampling weights.
// Pure arithmetic over caller data: no clock, randomness, I/O, filters or signature checks.
import type { ReasoningLevel } from '@gyblos/protocol/constants';
import type { PublicModelV2 } from '@gyblos/protocol/control-types';

import {
  SELLER_SELECTION_POLICY,
  type SellerSelectionPolicy,
} from './constants.js';
import {
  invalid,
  type KnownSeller,
  type SellerStats,
} from './seller-selection-input.js';

export interface Eligible {
  seller: KnownSeller;
  listing: PublicModelV2;
  stats: SellerStats | undefined;
}
export interface Weighted {
  entry: Eligible;
  reasoning: ReasoningLevel;
  downgrade: boolean;
  weight: number;
  fresh: boolean;
}

const POLICY_KEYS = Object.keys(SELLER_SELECTION_POLICY);
const isPositiveInteger = (value: number) =>
  Number.isSafeInteger(value) && value >= 1;
const isFraction = (value: number) => value >= 0 && value <= 1;

function hasPolicyShape(policy: unknown): policy is SellerSelectionPolicy {
  if (typeof policy !== 'object' || policy === null) return false;
  const values = new Map(Object.entries(policy));
  return POLICY_KEYS.every((key) => {
    const value = values.get(key);
    return typeof value === 'number' && Number.isFinite(value);
  });
}
// Every default key must be a finite number within the range its formula assumes.
export function checkPolicy(policy: unknown): SellerSelectionPolicy {
  if (!hasPolicyShape(policy)) invalid();
  const checked = policy;
  if (
    !isPositiveInteger(checked.maxSellers) ||
    !isPositiveInteger(checked.maxCandidates) ||
    !isPositiveInteger(checked.defaultCandidates) ||
    checked.defaultCandidates > checked.maxCandidates ||
    !(checked.freeWeightMultiple > 0) ||
    !(
      checked.openChannelPriceFactor > 0 && checked.openChannelPriceFactor <= 1
    ) ||
    !(checked.reputationMin > 0) ||
    checked.reputationMin > checked.reputationMax ||
    checked.successFactorBase < 0 ||
    !(checked.latencyReferenceMs > 0) ||
    !(checked.latencyFactorMin > 0) ||
    checked.latencyFactorMin > checked.latencyFactorMax ||
    !(checked.waitFactorBase > 0) ||
    !isFraction(checked.neutralWaitAccuracy) ||
    checked.historyPriorSamples < 0 ||
    !isFraction(checked.stickyWeightFraction)
  )
    invalid();
  return checked;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
export const hasHistory = (stats: SellerStats | undefined) =>
  stats !== undefined && stats.successes + stats.failures > 0;

// Bounded local factor: smoothed success rate times latency and wait factors, each shrunk toward
// neutral by the sample count, so a seller with no history scores the prior, not a perfect record.
export function reputation(
  stats: SellerStats | undefined,
  policy: SellerSelectionPolicy,
) {
  const successes = stats?.successes ?? 0;
  const samples = successes + (stats?.failures ?? 0);
  const trust = samples / (samples + policy.historyPriorSamples || 1);
  const rate = (successes + 1) / (samples + 2);
  const latencyMs = stats?.latencyMs ?? null;
  const rawLatency =
    latencyMs === null
      ? 1
      : clamp(
          policy.latencyReferenceMs / Math.max(latencyMs, 1),
          policy.latencyFactorMin,
          policy.latencyFactorMax,
        );
  const accuracy = stats?.waitAccuracy ?? null;
  const neutral = policy.neutralWaitAccuracy;
  const wait =
    accuracy === null ? neutral : neutral + (accuracy - neutral) * trust;
  return clamp(
    (policy.successFactorBase + rate) *
      (1 + (rawLatency - 1) * trust) *
      (policy.waitFactorBase + policy.waitFactorBase * wait),
    policy.reputationMin,
    policy.reputationMax,
  );
}
export const isFree = (listing: PublicModelV2) =>
  BigInt(listing.pricing.inputAtomic) === 0n &&
  BigInt(listing.pricing.outputAtomic) === 0n;

// Reference price is one input plus one output token, discounted for an open channel.
function unitPrice(entry: Eligible, policy: SellerSelectionPolicy) {
  const { pricing } = entry.listing;
  const total = Number(
    BigInt(pricing.inputAtomic) + BigInt(pricing.outputAtomic),
  );
  return entry.seller.openChannel
    ? total * policy.openChannelPriceFactor
    : total;
}
// Paid weight is (cheapest / price)^2 * reputation; free weighs a fixed multiple of the cheapest.
export function weigh(
  entries: readonly Eligible[],
  reasoning: ReasoningLevel,
  downgrade: boolean,
  policy: SellerSelectionPolicy,
): Weighted[] {
  const prices = entries.map((entry) => unitPrice(entry, policy));
  const paid = prices.filter((price) => price > 0);
  const cheapest = paid.length ? Math.min(...paid) : 1;
  return entries.map((entry, index) => {
    const price = prices[index] ?? 0;
    const priceWeight =
      price > 0 ? (cheapest / price) ** 2 : policy.freeWeightMultiple;
    return {
      entry,
      reasoning,
      downgrade,
      weight: priceWeight * reputation(entry.stats, policy),
      fresh: !hasHistory(entry.stats),
    };
  });
}
