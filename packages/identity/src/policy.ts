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

export function assertSponsorPolicyConfig(config: SponsorPolicyConfig): void {
  if (config.budgetLamports <= 0n || config.maxPerRegistrationLamports <= 0n) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.POLICY_CONFIG_INVALID,
      'sponsor budget and per-registration cap must be positive',
    );
  }
}

function inputReason(request: SponsorRequest): SponsorReason | undefined {
  if (!isCanonicalNodeId(request.deviceKey))
    return SPONSOR_REASONS.INVALID_DEVICE_KEY;
  if (!isAddress(request.owner)) return SPONSOR_REASONS.INVALID_OWNER;
  return undefined;
}

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
  const proof = await onlineCheck(request, challenge.slice());
  return verifyNodeSignature(
    request.deviceKey,
    onlineChallengeMessage(challenge, request),
    proof,
  );
}

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
