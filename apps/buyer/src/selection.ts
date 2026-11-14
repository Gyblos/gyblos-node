// Builds verified selector inputs and races signed quotes; legacy trust authorization is an explicit wrapper.
// Static operator identity trust stays independent of seller declarations; never executes payments.
import { randomInt } from 'node:crypto';

import { SELLER_BADGES } from '@gyblos/core/constants';
import {
  selectSellers,
  type KnownSeller,
  type SellerCandidate,
  type SellerSelectionResult,
} from '@gyblos/core/seller-selection';
import { CONTROL_CODES, PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { verifyPublicV2 } from '@gyblos/protocol/public-v2';

import {
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
  ERROR_DIAGNOSTICS,
  SELLER_FAILURE_PHASES,
  SELLER_FAILURES,
  type SellerFailurePhase,
} from './constants';
import type { createBuyerControlClient } from './control';
import { raceControlOffers, type WinningQuote } from './offer-race';
import type { SnapshotCache } from './selection-cache';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';
import { raceCandidates } from './selection-quotes';
import {
  recordQuote,
  refreshSnapshots,
  verifiedSeller,
} from './selection-snapshots';
import type { LocalSellerStats } from './selection-stats';
import {
  reportSellerFailure,
  sellerFailureCode,
  type SellerFailureCode,
  type SellerFailureReporter,
} from './seller-failures';

export { verifiedSeller };
export type BuyerControlClient = Pick<
  ReturnType<typeof createBuyerControlClient>,
  'getCatalog' | 'getPresence' | 'requestOffer' | 'close'
> &
  Partial<Pick<ReturnType<typeof createBuyerControlClient>, 'useCatalog'>>;
export type SelectionDecision =
  | { ok: true; winner: WinningQuote }
  | {
      ok: false;
      code: typeof BUYER_SELECTION_CODES.QUOTE_ONLY;
      winner: WinningQuote;
    }
  | { ok: false; code: typeof BUYER_SELECTION_CODES.NO_OFFER }
  | Exclude<SellerSelectionResult, { ok: true }>;
export interface VerifiedSelectionDependencies {
  connect: (seller: StaticControlSeller) => Promise<BuyerControlClient>;
  buyer: string;
  stats: Map<string, LocalSellerStats>;
  now?: () => number;
  random?: () => number;
  // The default quote window; a selection.json quoteWindowMs takes precedence.
  windowMs?: number;
  snapshotMs?: number;
  verifyIdentity?: (
    seller: StaticControlSeller,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  observeVerified?: (seller: KnownSeller) => Promise<boolean>;
  // Snapshots kept from earlier requests (selection-cache.ts); absent, every request asks every seller.
  snapshots?: SnapshotCache;
  // Told why each seller dropped out; it never affects which seller wins.
  onSellerFailure?: SellerFailureReporter;
}
// A seller that refused a quote for a remembered catalog is not counted as failing: its snapshot is
// dropped and, when no other seller won, the selection runs once more with fresh snapshots.
export async function selectVerifiedBuyerQuote(
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  signal?: AbortSignal,
): Promise<SelectionDecision> {
  const stale = new Set<string>();
  const first = await selectOnce(config, dependencies, stale, signal);
  if (first.ok || !stale.size || signal?.aborted) return first;
  return selectOnce(config, dependencies, new Set(), signal);
}
async function selectOnce(
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  stale: Set<string>,
  signal?: AbortSignal,
): Promise<SelectionDecision> {
  if (config.identity && !dependencies.verifyIdentity)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.IDENTITY);
  const now = dependencies.now ?? Date.now;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(dependencies.snapshotMs ?? BUYER_SELECTION.snapshotMs),
    ...(signal ? [signal] : []),
  ]);
  const clients = new Map<string, BuyerControlClient>();
  try {
    const snapshots = await refreshSnapshots(
      config,
      dependencies,
      clients,
      now,
      deadline,
      signal,
    );
    if (signal?.aborted)
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    const selected = selectSellers({
      request: config.request,
      sellers: snapshots.filter((item) => item !== undefined),
      stats: dependencies.stats,
      pinnedNodeId: config.pinnedNodeId,
      previousSeller: config.previousSeller,
      now: now(),
      random:
        dependencies.random ??
        (() =>
          randomInt(BUYER_SELECTION.randomRange) / BUYER_SELECTION.randomRange),
    });
    if (!selected.ok) return selected;
    const winner = await raceCandidates(
      selected.candidates,
      { clients, stale },
      config,
      dependencies,
      now,
      signal,
    );
    if (!winner) return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    const drop = (phase: SellerFailurePhase, code: SellerFailureCode) =>
      dropWinner(dependencies, winner, phase, code, signal);
    if (!offerCurrent(winner, now))
      return drop(SELLER_FAILURE_PHASES.QUOTE, CONTROL_CODES.EXPIRED);
    const seller = config.sellers.find(
      (item) =>
        item.nodeId === winner.candidate.nodeId &&
        item.owner === winner.candidate.owner,
    );
    if (
      !seller ||
      (dependencies.verifyIdentity &&
        !(await dependencies.verifyIdentity(seller, signal)))
    )
      return drop(SELLER_FAILURE_PHASES.IDENTITY, SELLER_FAILURES.IDENTITY);
    if (signal?.aborted)
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    if (!offerCurrent(winner, now))
      return drop(SELLER_FAILURE_PHASES.QUOTE, CONTROL_CODES.EXPIRED);
    return { ok: true, winner };
  } finally {
    await Promise.allSettled(
      [...clients.values()].map((client) => client.close()),
    );
  }
}

// The winner can still drop out after the race; it is reported like any other seller unless the
// caller cancelled.
function dropWinner(
  dependencies: VerifiedSelectionDependencies,
  winner: WinningQuote,
  phase: SellerFailurePhase,
  code: SellerFailureCode,
  signal?: AbortSignal,
): SelectionDecision {
  if (!signal?.aborted)
    reportSellerFailure(dependencies.onSellerFailure, {
      nodeId: winner.candidate.nodeId,
      phase,
      code,
    });
  return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
}

function offerCurrent(winner: WinningQuote, now: () => number) {
  try {
    validateOfferV2Time(winner.quote.offer, now());
    return true;
  } catch {
    return false;
  }
}

export interface SelectionDependencies extends VerifiedSelectionDependencies {
  trusted: { owner: string; nodeId: string };
}
// Legacy authorization is applied only by the paid entry, after the shared verified selection.
export async function selectBuyerQuote(
  config: BuyerSelectionConfig,
  dependencies: SelectionDependencies,
  signal?: AbortSignal,
): Promise<SelectionDecision> {
  const result = await selectVerifiedBuyerQuote(config, dependencies, signal);
  if (!result.ok) return result;
  return result.winner.candidate.nodeId === dependencies.trusted.nodeId &&
    result.winner.candidate.owner === dependencies.trusted.owner
    ? result
    : {
        ok: false,
        code: BUYER_SELECTION_CODES.QUOTE_ONLY,
        winner: result.winner,
      };
}
