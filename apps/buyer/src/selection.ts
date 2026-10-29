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
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
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
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';
import type { LocalSellerStats } from './selection-stats';
import {
  reportSellerFailure,
  sellerFailureCode,
  type SellerFailureReporter,
} from './seller-failures';

export type BuyerControlClient = Pick<
  ReturnType<typeof createBuyerControlClient>,
  'getCatalog' | 'getPresence' | 'requestOffer' | 'close'
>;
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
  // Told why each seller dropped out; it never affects which seller wins.
  onSellerFailure?: SellerFailureReporter;
}
async function verifiedSeller(
  client: BuyerControlClient,
  seller: StaticControlSeller,
  now: () => number,
  signal: AbortSignal,
): Promise<KnownSeller> {
  const signed = await client.getCatalog(signal);
  const trust = { owner: seller.owner, nodeId: seller.nodeId, now: now() };
  const catalog = await verifyPublicV2(signed, trust);
  if (catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  const presence = await verifyPublicV2(await client.getPresence(signal), {
    ...trust,
    now: now(),
    catalog,
  });
  if (presence.kind !== PUBLIC_RECORD_KINDS.PRESENCE)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  const withdrawal = seller.withdrawal
    ? await verifyPublicV2(seller.withdrawal, { ...trust, now: now(), catalog })
    : null;
  if (withdrawal && withdrawal.kind !== PUBLIC_RECORD_KINDS.WITHDRAWAL)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  return {
    catalog,
    presence,
    withdrawal,
    badge: SELLER_BADGES.DECLARED_USAGE,
    openChannel: false,
  };
}
function recordQuote(
  stats: Map<string, LocalSellerStats>,
  nodeId: string,
  success: boolean,
  latencyMs: number,
  now: number,
) {
  const prior = stats.get(nodeId);
  stats.set(nodeId, {
    successes: (prior?.successes ?? 0) + Number(success),
    failures: (prior?.failures ?? 0) + Number(!success),
    latencyMs: Math.max(0, Math.round(latencyMs)),
    waitAccuracy: prior?.waitAccuracy ?? null,
    cooldownUntil: success ? null : now + BUYER_SELECTION.cooldownMs,
    // v2 has no predicted wait and control latency is not inference waiting time.
    quotedWaitMs: prior?.quotedWaitMs ?? null,
    observedWaitMs: prior?.observedWaitMs ?? null,
  });
}
export async function selectVerifiedBuyerQuote(
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
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
    );
    if (signal?.aborted)
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    const selected = selectSellers({
      request: config.request,
      sellers: snapshots.filter((item) => item !== undefined),
      stats: dependencies.stats,
      pinnedNodeId: config.pinnedNodeId,
      now: now(),
      random:
        dependencies.random ??
        (() =>
          randomInt(BUYER_SELECTION.randomRange) / BUYER_SELECTION.randomRange),
    });
    if (!selected.ok) return selected;
    const winner = await raceCandidates(
      selected.candidates,
      clients,
      config,
      dependencies,
      now,
      signal,
    );
    if (!winner) return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    try {
      validateOfferV2Time(winner.quote.offer, now());
    } catch {
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    }
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
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    if (signal?.aborted)
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    try {
      validateOfferV2Time(winner.quote.offer, now());
    } catch {
      return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
    }
    return { ok: true, winner };
  } finally {
    await Promise.allSettled(
      [...clients.values()].map((client) => client.close()),
    );
  }
}

function raceCandidates(
  candidates: readonly SellerCandidate[],
  clients: ReadonlyMap<string, BuyerControlClient>,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  signal?: AbortSignal,
) {
  return raceControlOffers(
    candidates,
    (candidate, querySignal) =>
      requestCandidate(
        candidate,
        clients,
        config,
        dependencies,
        now,
        querySignal,
      ),
    {
      signal,
      // The operator's selection.json wins over the caller's default.
      windowMs: config.quoteWindowMs ?? dependencies.windowMs,
      // A seller silent for the whole window is cooled down like one that refused.
      onExpired: (pending) => {
        for (const candidate of pending) {
          recordQuote(dependencies.stats, candidate.nodeId, false, 0, now());
          reportSellerFailure(dependencies.onSellerFailure, {
            nodeId: candidate.nodeId,
            phase: SELLER_FAILURE_PHASES.TIMEOUT,
            code: ERROR_DIAGNOSTICS.TIMEOUT,
          });
        }
      },
    },
  );
}

async function requestCandidate(
  candidate: SellerCandidate,
  clients: ReadonlyMap<string, BuyerControlClient>,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  querySignal: AbortSignal,
) {
  const start = now();
  const request = config.request;
  try {
    const quote = await clients.get(candidate.nodeId)!.requestOffer(
      {
        buyer: dependencies.buyer,
        selection: request.selection,
        reasoning: candidate.reasoning,
        maxTokens: request.maxTokens,
        maxAtomic: candidate.free ? '0' : request.maxAtomic,
        priceCeilings: request.priceCeilings,
        network: request.network,
        asset: request.asset,
      },
      querySignal,
    );
    if (querySignal.aborted)
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    recordQuote(
      dependencies.stats,
      candidate.nodeId,
      true,
      now() - start,
      now(),
    );
    return quote;
  } catch (error) {
    if (!querySignal.aborted) {
      recordQuote(
        dependencies.stats,
        candidate.nodeId,
        false,
        now() - start,
        now(),
      );
      reportSellerFailure(dependencies.onSellerFailure, {
        nodeId: candidate.nodeId,
        phase: SELLER_FAILURE_PHASES.QUOTE,
        code: sellerFailureCode(error),
      });
    }
    throw error;
  }
}

function settledValues<T>(outcomes: PromiseSettledResult<T>[]) {
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

async function refreshSnapshots(
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  clients: Map<string, BuyerControlClient>,
  now: () => number,
  deadline: AbortSignal,
) {
  return settledValues(
    await Promise.allSettled(
      config.sellers.map(async (seller) => {
        const failed = (phase: SellerFailurePhase, code: string) =>
          reportSellerFailure(dependencies.onSellerFailure, {
            nodeId: seller.nodeId,
            phase,
            code,
          });
        try {
          if (
            dependencies.verifyIdentity &&
            !(await dependencies.verifyIdentity(seller, deadline))
          ) {
            failed(SELLER_FAILURE_PHASES.IDENTITY, SELLER_FAILURES.IDENTITY);
            return undefined;
          }
          deadline.throwIfAborted();
          const client = await dependencies.connect(seller);
          clients.set(seller.nodeId, client);
          const verified = await verifiedSeller(client, seller, now, deadline);
          if (
            dependencies.observeVerified &&
            !(await dependencies.observeVerified(verified))
          ) {
            failed(SELLER_FAILURE_PHASES.DISCOVERY, SELLER_FAILURES.DISCOVERY);
            return undefined;
          }
          return verified;
        } catch (error) {
          if (
            error instanceof BuyerSelectionError &&
            [
              BUYER_SELECTION_CODES.DISCOVERY_STATE,
              BUYER_SELECTION_CODES.IDENTITY_STATE,
            ].some((code) => error.code === code)
          )
            throw error;
          recordQuote(dependencies.stats, seller.nodeId, false, 0, now());
          failed(SELLER_FAILURE_PHASES.CONNECT, sellerFailureCode(error));
          return undefined;
        }
      }),
    ),
  );
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
