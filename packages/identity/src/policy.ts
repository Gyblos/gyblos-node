// Owns the sponsorship decision: one sponsored registration per device key and per owner,
// a per-registration cap, a total budget, and an injected online check. Must not know about RPC or storage.
import { SPONSOR_REASONS, type SponsorReason } from './constants.js';

export interface SponsorRequest {
  deviceKey: string;
  owner: string;
  costLamports: bigint;
}

export interface SponsorLedger {
  sponsoredDevices: ReadonlySet<string>;
  sponsoredOwners: ReadonlySet<string>;
  spentLamports: bigint;
}

export interface SponsorPolicyConfig {
  budgetLamports: bigint;
  maxPerRegistrationLamports: bigint;
}

export interface SponsorDecision {
  allow: boolean;
  reason: SponsorReason;
}

export type OnlineCheck = (request: SponsorRequest) => Promise<boolean>;

const ALLOWED: SponsorDecision = {
  allow: true,
  reason: SPONSOR_REASONS.ALLOWED,
};

function deny(reason: SponsorReason): SponsorDecision {
  return { allow: false, reason };
}

export const EMPTY_LEDGER: SponsorLedger = {
  sponsoredDevices: new Set(),
  sponsoredOwners: new Set(),
  spentLamports: 0n,
};

// Pure, synchronous rules; cheap checks run before the (network) online check.
export function evaluateSponsorRules(
  request: SponsorRequest,
  ledger: SponsorLedger,
  config: SponsorPolicyConfig,
): SponsorDecision {
  if (request.costLamports <= 0n) return deny(SPONSOR_REASONS.INVALID_COST);
  if (request.costLamports > config.maxPerRegistrationLamports)
    return deny(SPONSOR_REASONS.COST_ABOVE_CAP);
  if (ledger.sponsoredDevices.has(request.deviceKey))
    return deny(SPONSOR_REASONS.DEVICE_ALREADY_SPONSORED);
  if (ledger.sponsoredOwners.has(request.owner))
    return deny(SPONSOR_REASONS.OWNER_ALREADY_SPONSORED);
  if (ledger.spentLamports + request.costLamports > config.budgetLamports)
    return deny(SPONSOR_REASONS.BUDGET_EXCEEDED);
  return ALLOWED;
}

// A throwing online check is a denial (ONLINE_CHECK_ERROR), never an allow; the
// caller that owns the check is responsible for logging its failure.
export async function decideSponsorship(
  request: SponsorRequest,
  ledger: SponsorLedger,
  config: SponsorPolicyConfig,
  onlineCheck: OnlineCheck,
): Promise<SponsorDecision> {
  const rules = evaluateSponsorRules(request, ledger, config);
  if (!rules.allow) return rules;
  try {
    return (await onlineCheck(request))
      ? ALLOWED
      : deny(SPONSOR_REASONS.ONLINE_CHECK_FAILED);
  } catch {
    return deny(SPONSOR_REASONS.ONLINE_CHECK_ERROR);
  }
}

// Returns the ledger after a sponsorship; the caller persists it atomically with the decision.
export function recordSponsorship(
  ledger: SponsorLedger,
  request: SponsorRequest,
): SponsorLedger {
  return {
    sponsoredDevices: new Set([...ledger.sponsoredDevices, request.deviceKey]),
    sponsoredOwners: new Set([...ledger.sponsoredOwners, request.owner]),
    spentLamports: ledger.spentLamports + request.costLamports,
  };
}
