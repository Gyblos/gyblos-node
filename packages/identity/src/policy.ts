// Owns the sponsorship decision: one sponsored registration per canonical device key and owner,
// a per-registration cap, a total budget, and an injected online check. Must not know about RPC or storage.
import { isAddress } from '@solana/kit';

import { isCanonicalNodeId } from './binding.js';
import {
  IDENTITY_ERROR_CODES,
  SPONSOR_REASONS,
  type SponsorReason,
} from './constants.js';
import { IdentityError } from './errors.js';

// deviceKey is the canonical NodeId (64 lowercase hex); owner is a base58 Solana address.
// costLamports is everything the sponsor pays: prefund plus transaction fee.
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

// An operator config with a zero or negative cap or budget is a mistake, not a policy; it throws.
export function assertSponsorPolicyConfig(config: SponsorPolicyConfig): void {
  if (config.budgetLamports <= 0n || config.maxPerRegistrationLamports <= 0n) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.POLICY_CONFIG_INVALID,
      'sponsor budget and per-registration cap must be positive',
    );
  }
}

// Ledger keys must be canonical so one device or owner cannot appear under two spellings.
function inputReason(request: SponsorRequest): SponsorReason | undefined {
  if (!isCanonicalNodeId(request.deviceKey))
    return SPONSOR_REASONS.INVALID_DEVICE_KEY;
  if (!isAddress(request.owner)) return SPONSOR_REASONS.INVALID_OWNER;
  return undefined;
}

// Pure, synchronous rules; cheap checks run before the (network) online check.
export function evaluateSponsorRules(
  request: SponsorRequest,
  ledger: SponsorLedger,
  config: SponsorPolicyConfig,
): SponsorDecision {
  assertSponsorPolicyConfig(config);
  const invalidInput = inputReason(request);
  if (invalidInput !== undefined) return deny(invalidInput);
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
// A non-canonical request never reaches the ledger.
export function recordSponsorship(
  ledger: SponsorLedger,
  request: SponsorRequest,
): SponsorLedger {
  const invalidInput = inputReason(request);
  if (invalidInput !== undefined) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      `cannot record sponsorship: ${invalidInput}`,
    );
  }
  return {
    sponsoredDevices: new Set([...ledger.sponsoredDevices, request.deviceKey]),
    sponsoredOwners: new Set([...ledger.sponsoredOwners, request.owner]),
    spentLamports: ledger.spentLamports + request.costLamports,
  };
}
