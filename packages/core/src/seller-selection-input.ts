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
} from '@gyblos/protocol/control-types';

import {
  SELLER_BADGE_ORDER,
  SELLER_SELECTION_CODES,
  SELLER_SELECTION_POLICY,
  type SellerBadge,
} from './constants.js';

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
  priceCeilings: { inputAtomic: string; outputAtomic: string };
  maxAtomic: string;
  minimumBadge: SellerBadge;
  // Seller retention declarations the buyer accepts; a declaration is not a privacy guarantee.
  retention: readonly DataRetention[];
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
  now: number;
  // Returns a value in [0, 1); the caller owns seeding.
  random: () => number;
  count?: number;
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
const isRecord = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const levelRank = (level: ReasoningLevel) => LEVEL_ORDER.indexOf(level);

function checkRequest(request: SellerRequest) {
  if (!isRecord(request)) invalid();
  const lowest = request.lowestReasoning;
  if (
    !LEVEL_ORDER.includes(request.reasoning) ||
    (lowest !== null &&
      (!LEVEL_ORDER.includes(lowest) ||
        levelRank(lowest) >= levelRank(request.reasoning))) ||
    typeof request.selection?.modelId !== 'string' ||
    typeof request.network !== 'string' ||
    typeof request.asset !== 'string' ||
    !isCount(request.maxTokens) ||
    request.maxTokens < 1 ||
    !isAtomic(request.priceCeilings?.inputAtomic) ||
    !isAtomic(request.priceCeilings.outputAtomic) ||
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
export function checkInput(input: SellerSelectionInput) {
  if (!isRecord(input)) invalid();
  const count = input.count ?? SELLER_SELECTION_POLICY.defaultCandidates;
  if (
    !isCount(input.now) ||
    typeof input.random !== 'function' ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > SELLER_SELECTION_POLICY.maxCandidates ||
    !Array.isArray(input.sellers) ||
    input.sellers.length > SELLER_SELECTION_POLICY.maxSellers ||
    !(input.stats instanceof Map) ||
    (input.pinnedNodeId !== undefined && typeof input.pinnedNodeId !== 'string')
  )
    invalid();
  checkRequest(input.request);
  for (const stats of input.stats.values()) checkStats(stats);
  const seen = new Set<string>();
  for (const seller of input.sellers) {
    if (
      !isRecord(seller) ||
      !isRecord(seller.catalog) ||
      !SELLER_BADGE_ORDER.includes(seller.badge) ||
      seen.has(seller.catalog.nodeId)
    )
      invalid();
    seen.add(seller.catalog.nodeId);
  }
  return count;
}
