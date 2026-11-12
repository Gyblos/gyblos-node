// Declares seller-selection inputs and rejects malformed caller input with one typed code.
// Pure validation: it never reads records beyond shape and bounds, and never echoes input.
import {
  DATA_RETENTION,
  PUBLIC_RECORD_LIMITS,
  REASONING_LEVELS,
  type DataRetention,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type {
  ModelSelection,
  PublicCatalogV2,
  PublicPresenceV2,
  PublicWithdrawalV2,
  TokenPricesV2,
} from '@gyblos/protocol/control-types';

import {
  SELLER_BADGE_ORDER,
  SELLER_SELECTION_CODES,
  type SellerBadge,
  type SellerSelectionPolicy,
} from './constants';

export const LEVEL_ORDER: readonly ReasoningLevel[] = [
  REASONING_LEVELS.OFF,
  REASONING_LEVELS.LOW,
  REASONING_LEVELS.MEDIUM,
  REASONING_LEVELS.HIGH,
];
const RETENTIONS: readonly DataRetention[] = Object.values(DATA_RETENTION);

export interface SellerRequest {
  selection: ModelSelection;
  reasoning: ReasoningLevel;
  // Lowest acceptable level of the same model, strictly below `reasoning`; null forbids downgrade.
  lowestReasoning: ReasoningLevel | null;
  network: string;
  asset: string;
  maxTokens: number;
  priceCeilings: TokenPricesV2;
  maxAtomic: string;
  minimumBadge: SellerBadge;
  // Seller retention declarations the buyer accepts; a declaration is not a privacy guarantee.
  retention: readonly DataRetention[];
  // Set for a free request that offers tools: quotes ask for them and only sellers serving tools quote.
  tools?: true;
}
export interface KnownSeller {
  catalog: PublicCatalogV2;
  presence: PublicPresenceV2 | null;
  withdrawal: PublicWithdrawalV2 | null;
  badge: SellerBadge;
  openChannel: boolean;
}
export interface SellerStats {
  successes: number;
  failures: number;
  latencyMs: number | null;
  // 1 when quoted waits matched observed waits, 0 when they never did.
  waitAccuracy: number | null;
  cooldownUntil: number | null;
}
export interface SellerSelectionInput {
  request: SellerRequest;
  sellers: readonly KnownSeller[];
  stats: ReadonlyMap<string, SellerStats>;
  pinnedNodeId?: string;
  // NodeId that served this conversation before; it keeps the first slot while competitive.
  previousSeller?: string;
  now: number;
  // Returns a value in [0, 1); the caller owns seeding.
  random: () => number;
  count?: number;
  // Defaults to SELLER_SELECTION_POLICY; a gateway may run the same selection with its own values.
  policy?: SellerSelectionPolicy;
}
// Internal signal for invalid caller input; converted to a typed result, never echoed.
export class SelectionInputError extends Error {}
export function invalid(): never {
  throw new SelectionInputError(SELLER_SELECTION_CODES.INVALID);
}

export function isAtomic(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PUBLIC_RECORD_LIMITS.maxAtomicDigits &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
  );
}
const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLabel = (value: unknown) => value === null || typeof value === 'string';
const isLevel = (value: unknown): value is ReasoningLevel =>
  LEVEL_ORDER.some((level) => level === value);
export const levelRank = (level: ReasoningLevel) => LEVEL_ORDER.indexOf(level);

function isSelection(selection: unknown) {
  return (
    isRecord(selection) &&
    typeof selection.modelId === 'string' &&
    isLabel(selection.variant) &&
    isLabel(selection.quantization)
  );
}
function checkRequest(request: SellerRequest) {
  if (!isRecord(request) || !isRecord(request.priceCeilings)) invalid();
  const lowest = request.lowestReasoning;
  if (
    !LEVEL_ORDER.includes(request.reasoning) ||
    (lowest !== null &&
      (!LEVEL_ORDER.includes(lowest) ||
        levelRank(lowest) >= levelRank(request.reasoning))) ||
    !isSelection(request.selection) ||
    typeof request.network !== 'string' ||
    typeof request.asset !== 'string' ||
    !isCount(request.maxTokens) ||
    request.maxTokens < 1 ||
    !isAtomic(request.priceCeilings.inputAtomicPerMtok) ||
    !isAtomic(request.priceCeilings.outputAtomicPerMtok) ||
    !isAtomic(request.maxAtomic) ||
    !SELLER_BADGE_ORDER.includes(request.minimumBadge) ||
    !Array.isArray(request.retention) ||
    request.retention.length === 0 ||
    !request.retention.every((item) => RETENTIONS.includes(item))
  )
    invalid();
}
function checkStats(stats: SellerStats) {
  if (!isRecord(stats)) invalid();
  const { latencyMs, waitAccuracy, cooldownUntil } = stats;
  if (
    !isCount(stats.successes) ||
    !isCount(stats.failures) ||
    (latencyMs !== null && (!Number.isFinite(latencyMs) || latencyMs < 0)) ||
    (waitAccuracy !== null &&
      (!Number.isFinite(waitAccuracy) ||
        waitAccuracy < 0 ||
        waitAccuracy > 1)) ||
    (cooldownUntil !== null && !isCount(cooldownUntil))
  )
    invalid();
}
// Only the fields selection reads; signatures and digests are the caller's verification step.
function isListing(listing: unknown) {
  return (
    isSelection(listing) &&
    isRecord(listing) &&
    isCount(listing.contextTokens) &&
    isRecord(listing.pricing) &&
    typeof listing.pricing.network === 'string' &&
    typeof listing.pricing.asset === 'string' &&
    typeof listing.pricing.inputAtomicPerMtok === 'string' &&
    typeof listing.pricing.outputAtomicPerMtok === 'string' &&
    Array.isArray(listing.reasoning) &&
    listing.reasoning.every(isLevel)
  );
}
function isHeader(record: unknown): record is Record<string, unknown> {
  return (
    isRecord(record) &&
    typeof record.owner === 'string' &&
    typeof record.nodeId === 'string' &&
    isCount(record.sequence) &&
    isCount(record.issuedAt) &&
    isCount(record.expiresAt)
  );
}
function checkSeller(seller: KnownSeller) {
  if (!isRecord(seller)) invalid();
  const { catalog, presence, withdrawal } = seller;
  if (
    !isHeader(catalog) ||
    !isRecord(catalog.dataPolicy) ||
    typeof catalog.dataPolicy.retention !== 'string' ||
    !Array.isArray(catalog.models) ||
    catalog.models.length > PUBLIC_RECORD_LIMITS.maxModels ||
    !catalog.models.every(isListing) ||
    (presence !== null && !isHeader(presence)) ||
    (withdrawal !== null && !isHeader(withdrawal)) ||
    !SELLER_BADGE_ORDER.includes(seller.badge) ||
    typeof seller.openChannel !== 'boolean'
  )
    invalid();
}
export function checkInput(
  input: SellerSelectionInput,
  count: number,
  policy: SellerSelectionPolicy,
) {
  if (
    !isCount(input.now) ||
    typeof input.random !== 'function' ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > policy.maxCandidates ||
    !Array.isArray(input.sellers) ||
    input.sellers.length > policy.maxSellers ||
    !(input.stats instanceof Map) ||
    (input.pinnedNodeId !== undefined &&
      typeof input.pinnedNodeId !== 'string') ||
    (input.previousSeller !== undefined &&
      typeof input.previousSeller !== 'string')
  )
    invalid();
  checkRequest(input.request);
  for (const [key, stats] of input.stats) {
    if (typeof key !== 'string') invalid();
    checkStats(stats);
  }
  const seen = new Set<string>();
  for (const seller of input.sellers) {
    checkSeller(seller);
    if (seen.has(seller.catalog.nodeId)) invalid();
    seen.add(seller.catalog.nodeId);
  }
}
