// Chooses buyer-side seller candidates from caller-validated v2 catalogs, presence and local stats.
// Pure policy: no clock, randomness, filesystem, network or signature checks; callers inject them.
import type { ReasoningLevel } from '@gyblos/protocol/constants';
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
} from './constants.js';
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
} from './seller-selection-input.js';
import {
  checkPolicy,
  isFree,
  weigh,
  type Eligible,
  type Weighted,
} from './seller-selection-weight.js';

export type {
  KnownSeller,
  SellerRequest,
  SellerSelectionInput,
  SellerStats,
} from './seller-selection-input.js';

export interface SellerCandidate {
  owner: string;
  nodeId: string;
  listing: PublicModelV2;
  reasoning: ReasoningLevel;
  downgrade: boolean;
  exploration: boolean;
  free: boolean;
  openChannel: boolean;
}
export type SellerSelectionResult =
  | { ok: true; candidates: SellerCandidate[] }
  | { ok: false; code: SellerSelectionCode };

const withinLifetime = (
  record: { issuedAt: number; expiresAt: number },
  now: number,
) => record.issuedAt <= now && now < record.expiresAt;

// Presence must be fresh and newer than its catalog; a later withdrawal tombstones that catalog.
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
function passesSellerFilters(
  seller: KnownSeller,
  request: SellerRequest,
  stats: SellerStats | undefined,
  now: number,
) {
  return (
    isLive(seller, now) &&
    SELLER_BADGE_ORDER.indexOf(seller.badge) >=
      SELLER_BADGE_ORDER.indexOf(request.minimumBadge) &&
    request.retention.includes(seller.catalog.dataPolicy.retention) &&
    (stats?.cooldownUntil == null || stats.cooldownUntil <= now)
  );
}
// A paid budget must cover at least one input plus one output token at the listed prices.
function passesListingFilters(listing: PublicModelV2, request: SellerRequest) {
  const { pricing } = listing;
  if (!isAtomic(pricing.inputAtomic) || !isAtomic(pricing.outputAtomic))
    return false;
  const input = BigInt(pricing.inputAtomic);
  const output = BigInt(pricing.outputAtomic);
  return (
    pricing.network === request.network &&
    pricing.asset === request.asset &&
    listing.contextTokens >= request.maxTokens &&
    input <= BigInt(request.priceCeilings.inputAtomic) &&
    output <= BigInt(request.priceCeilings.outputAtomic) &&
    (isFree(listing) || BigInt(request.maxAtomic) >= input + output)
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
function eligible(input: SellerSelectionInput, seller: KnownSeller) {
  const stats = input.stats.get(seller.catalog.nodeId);
  if (!passesSellerFilters(seller, input.request, stats, input.now)) return;
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

function draw(random: () => number) {
  const value = random();
  if (typeof value !== 'number' || !(value >= 0 && value < 1)) invalid();
  return value;
}
// Removes and returns one weighted item from `pool` (and from `remaining` when distinct).
function take(
  pool: Weighted[],
  remaining: Weighted[],
  random: () => number,
): Weighted {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let target = draw(random) * total;
  let index = pool.length - 1;
  for (let cursor = 0; cursor < pool.length; cursor++) {
    target -= pool[cursor]!.weight;
    if (target < 0) {
      index = cursor;
      break;
    }
  }
  const [chosen] = pool.splice(index, 1);
  if (pool !== remaining) remaining.splice(remaining.indexOf(chosen!), 1);
  return chosen!;
}
function toCandidate(item: Weighted, exploration: boolean): SellerCandidate {
  const { seller, listing } = item.entry;
  return {
    owner: seller.catalog.owner,
    nodeId: seller.catalog.nodeId,
    listing,
    reasoning: item.reasoning,
    downgrade: item.downgrade,
    exploration,
    free: isFree(listing),
    openChannel: seller.openChannel,
  };
}
// Weighted sampling without replacement; the last slot goes to a no-history seller when none won one.
function sampleTier(
  tier: Weighted[],
  slots: number,
  random: () => number,
): SellerCandidate[] {
  const remaining = [...tier];
  const reserve =
    slots >= 2 &&
    remaining.some((item) => item.fresh) &&
    remaining.some((item) => !item.fresh);
  const picked: { item: Weighted; exploration: boolean }[] = [];
  const regular = reserve ? slots - 1 : slots;
  while (picked.length < regular && remaining.length)
    picked.push({
      item: take(remaining, remaining, random),
      exploration: false,
    });
  if (reserve && remaining.length) {
    const newcomers = remaining.filter((item) => item.fresh);
    const explore =
      newcomers.length > 0 && !picked.some((choice) => choice.item.fresh);
    picked.push({
      item: take(explore ? newcomers : remaining, remaining, random),
      exploration: explore,
    });
  }
  return picked.map((choice) => toCandidate(choice.item, choice.exploration));
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
  const entry = seller && eligible(input, seller);
  if (!entry) return rejected;
  const levels = acceptableLevels(input.request);
  const level = levels.find((item) => entry.listing.reasoning.includes(item));
  if (level === undefined) return rejected;
  const [weighted] = weigh(
    [entry],
    level,
    level !== input.request.reasoning,
    policy,
  );
  return { ok: true, candidates: [toCandidate(weighted!, false)] };
}
function selectAutomatic(
  input: SellerSelectionInput,
  count: number,
  policy: SellerSelectionPolicy,
): SellerSelectionResult {
  const pool = input.sellers.flatMap((seller) => eligible(input, seller) ?? []);
  const [exact, ...lower] = acceptableLevels(input.request);
  const exactTier = pool.filter((entry) =>
    entry.listing.reasoning.includes(exact!),
  );
  const candidates = sampleTier(
    weigh(exactTier, exact!, false, policy),
    count,
    input.random,
  );
  // Only the closest lower level with any non-exact survivor fills slots, after every exact candidate.
  const supportsOnly = (level: ReasoningLevel) =>
    pool.filter(
      (entry) =>
        !exactTier.includes(entry) && entry.listing.reasoning.includes(level),
    );
  const fallback = lower.find((level) => supportsOnly(level).length > 0);
  if (candidates.length < count && fallback !== undefined)
    candidates.push(
      ...sampleTier(
        weigh(supportsOnly(fallback), fallback, true, policy),
        count - candidates.length,
        input.random,
      ),
    );
  if (candidates.length) return { ok: true, candidates };
  return {
    ok: false,
    code: pool.length
      ? SELLER_SELECTION_CODES.LEVEL_UNSUPPORTED
      : SELLER_SELECTION_CODES.NO_CANDIDATES,
  };
}

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
