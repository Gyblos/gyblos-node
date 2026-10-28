// Owns the sponsorship decision: one sponsored registration per canonical device key and owner, a cap, a
// budget, and a required online check answered by the node key. Must not know about RPC or storage.
// Wiring is blocked until a real Iroh + catalog online check exists; see docs/identity.md.
import { address, getAddressEncoder, isAddress } from '@solana/kit';

import {
  isCanonicalNodeId,
  nodeIdToBytes,
  verifyNodeSignature,
} from './binding';
import { concatBytes, utf8 } from './bytes';
import {
  IDENTITY_ERROR_CODES,
  ONLINE_CHALLENGE,
  SPONSOR_REASONS,
  type SponsorReason,
} from './constants';
import { IdentityError } from './errors';

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

// The online check has no default and cannot be a bare "true": it must deliver the fresh challenge to the
// node (the real check dials its NodeId over Iroh and checks its catalog) and return the node key's
// signature over onlineChallengeMessage(challenge, request). That proves only that the check reached a
// holder of the device key; Sybil resistance still depends on what the real check verifies.
export type OnlineCheck = (
  request: SponsorRequest,
  challenge: Uint8Array,
) => Promise<Uint8Array>;

const ADDRESS_ENCODER = getAddressEncoder();

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

// What the node signs to answer a challenge: domain ‖ challenge ‖ nodeId ‖ owner.
export function onlineChallengeMessage(
  challenge: Uint8Array,
  request: SponsorRequest,
): Uint8Array {
  return concatBytes([
    utf8(ONLINE_CHALLENGE.domain),
    challenge,
    nodeIdToBytes(request.deviceKey),
    new Uint8Array(ADDRESS_ENCODER.encode(address(request.owner))),
  ]);
}

async function onlineProofValid(
  request: SponsorRequest,
  onlineCheck: OnlineCheck,
): Promise<boolean> {
  const challenge = crypto.getRandomValues(
    new Uint8Array(ONLINE_CHALLENGE.challengeBytes),
  );
  // The check gets a copy so it cannot change the challenge it is judged against.
  const proof = await onlineCheck(request, challenge.slice());
  return verifyNodeSignature(
    request.deviceKey,
    onlineChallengeMessage(challenge, request),
    proof,
  );
}

// A wrong or missing signature denies (ONLINE_CHECK_FAILED); a throwing check denies (ONLINE_CHECK_ERROR),
// never an allow. The caller that owns the check is responsible for logging its failure.
export async function decideSponsorship(
  request: SponsorRequest,
  ledger: SponsorLedger,
  config: SponsorPolicyConfig,
  onlineCheck: OnlineCheck,
): Promise<SponsorDecision> {
  const rules = evaluateSponsorRules(request, ledger, config);
  if (!rules.allow) return rules;
  try {
    return (await onlineProofValid(request, onlineCheck))
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
