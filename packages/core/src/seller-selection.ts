// Chooses buyer-side seller candidates from caller-verified v2 catalogs, presence and local stats.
// Pure policy: no clock, randomness, filesystem, network or signature checks; callers inject them.
// The caller contract (verification, badge, offer race) is documented above `selectSellers`.
import {
  CONTROL_LIMITS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type {
  ModelSelection,
  PublicCatalogV2,
  PublicModelV2,
} from '@gyblos/protocol/control-types';

import {
  SELLER_BADGE_ORDER,
  SELLER_SELECTION_CODES,
  SELLER_SELECTION_POLICY,
  type SellerSelectionCode,
  type SellerSelectionPolicy,
} from './constants';
import { chargeV2 } from './pricing-v2';
import {
  checkInput,
  invalid,
  isAtomic,
  LEVEL_ORDER,
  levelRank,
  SelectionInputError,
  type KnownSeller,
  type SellerRequest,
  type SellerSelectionInput,
  type SellerStats,
} from './seller-selection-input';
import {
  findSticky,
  onePerOwner,
  sampleTier,
  toCandidate,
  type SellerCandidate,
} from './seller-selection-sample';
import {
  checkPolicy,
  isFree,
  weigh,
  type Eligible,
} from './seller-selection-weight';

export type { SellerCandidate } from './seller-selection-sample';
export type {
  KnownSeller,
  SellerRequest,
  SellerSelectionInput,
  SellerStats,
} from './seller-selection-input';

type CooldownCode = typeof SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN;
export type SellerSelectionResult =
  | { ok: true; candidates: SellerCandidate[] }
  // Only the cooldown end is returned, never other caller input.
  | { ok: false; code: CooldownCode; cooldownUntil: number }
  | { ok: false; code: Exclude<SellerSelectionCode, CooldownCode> };

// A record signed an instant ago on a clock slightly ahead is live, as in verification; expiry is exact.
const withinLifetime = (
  record: { issuedAt: number; expiresAt: number },
  now: number,
) =>
  record.issuedAt <= now + CONTROL_LIMITS.clockSkewMs && now < record.expiresAt;

// Presence must be fresh and newer than its catalog; a later withdrawal tombstones that catalog.
// Only owner, NodeId, sequence and lifetimes are compared here; the catalogDigest binding is the
// caller's verifyPublicV2 step. A withdrawal's owner/NodeId is not compared: a mismatched
// withdrawal with a later sequence still excludes the seller, which errs on the safe side.
function isLive(seller: KnownSeller, now: number) {
  const { catalog, presence, withdrawal } = seller;
  return (
    presence !== null &&
    presence.owner === catalog.owner &&
    presence.nodeId === catalog.nodeId &&
    presence.sequence > catalog.sequence &&
    withinLifetime(presence, now) &&
    withinLifetime(catalog, now) &&
    (withdrawal === null || withdrawal.sequence <= catalog.sequence)
  );
}
const isCooling = (stats: SellerStats | undefined, now: number) =>
  stats?.cooldownUntil != null && stats.cooldownUntil > now;
function passesSellerFilters(
  seller: KnownSeller,
  request: SellerRequest,
  now: number,
) {
  return (
    isLive(seller, now) &&
    SELLER_BADGE_ORDER.indexOf(seller.badge) >=
      SELLER_BADGE_ORDER.indexOf(request.minimumBadge) &&
    request.retention.includes(seller.catalog.dataPolicy.retention)
  );
}
// A paid budget must cover at least one input plus one output token at the listed prices.
function passesListingFilters(listing: PublicModelV2, request: SellerRequest) {
  const { pricing } = listing;
  if (
    !isAtomic(pricing.inputAtomicPerMtok) ||
    !isAtomic(pricing.outputAtomicPerMtok)
  )
    return false;
  const input = BigInt(pricing.inputAtomicPerMtok);
  const output = BigInt(pricing.outputAtomicPerMtok);
  return (
    pricing.network === request.network &&
    pricing.asset === request.asset &&
    listing.contextTokens >= request.maxTokens &&
    input <= BigInt(request.priceCeilings.inputAtomicPerMtok) &&
    output <= BigInt(request.priceCeilings.outputAtomicPerMtok) &&
    (isFree(listing) ||
      BigInt(request.maxAtomic) >=
        chargeV2(
          { input: 1, output: 1 },
          {
            inputAtomicPerMtok: pricing.inputAtomicPerMtok,
            outputAtomicPerMtok: pricing.outputAtomicPerMtok,
          },
        ))
  );
}
function findListing(catalog: PublicCatalogV2, selection: ModelSelection) {
  return catalog.models.find(
    (item) =>
      item.modelId === selection.modelId &&
      item.variant === selection.variant &&
      item.quantization === selection.quantization,
  );
}
// Every hard filter except the reasoning level, which decides tiers and the unsupported-level code.
// The pinned path checks cooldown itself so it can report when the seller returns.
function eligible(
  input: SellerSelectionInput,
  seller: KnownSeller,
  honorCooldown = true,
) {
  const stats = input.stats.get(seller.catalog.nodeId);
  if (honorCooldown && isCooling(stats, input.now)) return;
  if (!passesSellerFilters(seller, input.request, input.now)) return;
  const listing = findListing(seller.catalog, input.request.selection);
  if (!listing || !passesListingFilters(listing, input.request)) return;
  const entry: Eligible = { seller, listing, stats };
  return entry;
}
// Levels to try in order: the exact one, then each permitted lower level, closest first.
function acceptableLevels(request: SellerRequest) {
  const top = levelRank(request.reasoning);
  const bottom =
    request.lowestReasoning === null ? top : levelRank(request.lowestReasoning);
  return LEVEL_ORDER.slice(bottom, top + 1).reverse();
}

function selectPinned(
  input: SellerSelectionInput,
  pinnedNodeId: string,
  policy: SellerSelectionPolicy,
): SellerSelectionResult {
  const rejected = {
    ok: false,
    code: SELLER_SELECTION_CODES.PINNED_REJECTED,
  } as const;
  const seller = input.sellers.find(
    (item) => item.catalog.nodeId === pinnedNodeId,
  );
  const entry = seller && eligible(input, seller, false);
  if (!entry) return rejected;
  const levels = acceptableLevels(input.request);
  const level = levels.find((item) => entry.listing.reasoning.includes(item));
  if (level === undefined) return rejected;
  const cooldownUntil = entry.stats?.cooldownUntil;
  if (cooldownUntil != null && isCooling(entry.stats, input.now))
    return {
      ok: false,
      code: SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN,
      cooldownUntil,
    };
  const [weighted] = weigh(
    [entry],
    level,
    level !== input.request.reasoning,
    policy,
  );
  return { ok: true, candidates: [toCandidate(weighted!, false, false)] };
}
// Exact-level candidates first; remaining slots fall to each permitted lower level, closest first.
// Every tier is computed only while slots remain, and no seller or owner appears twice.
function selectAutomatic(
  input: SellerSelectionInput,
  count: number,
  policy: SellerSelectionPolicy,
): SellerSelectionResult {
  const pool = input.sellers.flatMap((seller) => eligible(input, seller) ?? []);
  const used = new Set<Eligible>();
  const owners = new Set<string>();
  const candidates: SellerCandidate[] = [];
  for (const [rank, level] of acceptableLevels(input.request).entries()) {
    if (candidates.length >= count) break;
    const tier = pool.filter(
      (entry) => !used.has(entry) && entry.listing.reasoning.includes(level),
    );
    for (const entry of tier) used.add(entry);
    const weighted = onePerOwner(weigh(tier, level, rank > 0, policy), owners);
    // Only the first tier that yields candidates can keep the previous seller first.
    const sticky = candidates.length
      ? undefined
      : findSticky(weighted, input.previousSeller, policy.stickyWeightFraction);
    const picked = sampleTier(
      weighted,
      count - candidates.length,
      input.random,
      sticky,
    );
    for (const candidate of picked) owners.add(candidate.owner);
    candidates.push(...picked);
  }
  if (candidates.length) return { ok: true, candidates };
  return {
    ok: false,
    code: pool.length
      ? SELLER_SELECTION_CODES.LEVEL_UNSUPPORTED
      : SELLER_SELECTION_CODES.NO_CANDIDATES,
  };
}

// Caller contract:
// - Verify every catalog with verifyPublicV2, then its presence and any withdrawal with
//   verifyPublicV2 against this exact catalog (`trust.catalog`), which binds their catalogDigest.
//   Selection never recomputes digests or signatures.
// - Supply each seller's checkability badge; the v2 catalog carries none.
// - Candidates are ordered exact-level first. The live-offer race must never accept a downgrade
//   offer while an exact candidate's offer is pending or available.
// - `policy` defaults to SELLER_SELECTION_POLICY; `previousSeller` is a hint, never a pin.
export function selectSellers(
  input: SellerSelectionInput,
): SellerSelectionResult {
  try {
    if (!input || typeof input !== 'object') invalid();
    // Only an omitted policy or count takes the default; null is malformed input.
    const policy = checkPolicy(
      input.policy === undefined ? SELLER_SELECTION_POLICY : input.policy,
    );
    const count =
      input.count === undefined ? policy.defaultCandidates : input.count;
    checkInput(input, count, policy);
    return input.pinnedNodeId === undefined
      ? selectAutomatic(input, count, policy)
      : selectPinned(input, input.pinnedNodeId, policy);
  } catch (error) {
    if (error instanceof SelectionInputError)
      return { ok: false, code: SELLER_SELECTION_CODES.INVALID };
    throw error;
  }
}
