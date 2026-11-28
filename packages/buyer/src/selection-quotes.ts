// The quote race of one selection: each candidate asked for a signed quote on the connection its
// snapshot came from, or on a new one starting from a remembered catalog; stats and failures recorded.
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import {
  BUYER_SELECTION_CODES,
  ERROR_DIAGNOSTICS,
  SELLER_FAILURE_PHASES,
} from './constants';
import { SellerRefusal, staleSellerCatalog } from './control';
import { raceControlOffers } from './offer-race';
import type {
  BuyerControlClient,
  VerifiedSelectionDependencies,
} from './selection';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
} from './selection-config';
import { connectBefore, recordQuote } from './selection-snapshots';
import {
  quoteFailureCode,
  reportSellerFailure,
  sellerFailureCode,
  type SellerFailureCode,
} from './seller-failures';

// After the race, every losing query is cancelled; the caller's cleanup waits for those to settle (a
// cancelled query settles at once), so each one has already handed its connection to background closing
// before the remaining ones are closed and awaited.
export interface RaceState {
  clients: Map<string, BuyerControlClient>;
  settling: Promise<unknown>[];
  // Sellers whose remembered catalog turned out stale in this selection.
  stale: Set<string>;
  // The remembered signed catalog of each seller whose snapshot came from memory.
  recalled: Map<string, SignedPublicV2>;
}
const CATALOG_CHANGED: ReadonlySet<SellerFailureCode> = new Set([
  CONTROL_CODES.STALE,
  CONTROL_CODES.MODEL,
]);

// A seller without tools answered as designed: it is not cooled down for the requests it serves. Any
// other refused quote cools it down; returns when it is tried again.
function coolAfterQuote(
  code: SellerFailureCode,
  nodeId: string,
  context: {
    dependencies: VerifiedSelectionDependencies;
    elapsedMs: number;
    now: number;
    signal?: AbortSignal;
  },
) {
  const { dependencies } = context;
  // Neither refusal is a fault: the seller serves other requests (without tools, or smaller ones).
  if (code === CONTROL_CODES.TOOLS || code === CONTROL_CODES.TOO_SLOW)
    return null;
  return recordQuote(
    dependencies.stats,
    nodeId,
    false,
    context.elapsedMs,
    context.now,
    dependencies.backoff,
  );
}

// A quote that did not arrive leaves a connection that may be dialing a seller that is gone, and closing
// that waits out the transport: it closes in the background. A pinned seller's is still awaited (it is
// asked again next), and so is every one of a request the caller cancelled.
function releaseInBackground(
  race: RaceState,
  nodeId: string,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  signal?: AbortSignal,
) {
  const { clients, settling } = race;
  const client = clients.get(nodeId);
  if (!client || signal?.aborted || nodeId === config.pinnedNodeId) return;
  clients.delete(nodeId);
  const closing = client.close().catch(() => undefined);
  settling.push(closing);
  dependencies.snapshots?.retire(nodeId, closing);
}

// A quote request with the input size. The seller that answered this conversation's last turn within
// FREE_BUYER.warmCacheMs likely holds most of it in its prompt cache, so the full size would overstate
// its reading: it is not sent.
// A seller from before quotes carried the size refuses that key as invalid. It is asked once more
// without it and quotes as it did then; only the retry's outcome counts for or against it. Only the
// seller's own refusal does: this buyer's checks of its answer are never retried.
async function requestSized(
  client: BuyerControlClient,
  params: Parameters<BuyerControlClient['requestOffer']>[0],
  {
    config,
    nodeId,
    signal,
  }: { config: BuyerSelectionConfig; nodeId: string; signal: AbortSignal },
) {
  const inputTokens =
    nodeId === config.warmSeller ? undefined : config.request.inputTokens;
  if (!inputTokens) return client.requestOffer(params, signal);
  try {
    return await client.requestOffer({ ...params, inputTokens }, signal);
  } catch (error) {
    if (
      signal.aborted ||
      !(error instanceof SellerRefusal) ||
      error.code !== CONTROL_CODES.INVALID
    )
      throw error;
    return client.requestOffer(params, signal);
  }
}

export async function raceCandidates(
  candidates: readonly SellerCandidate[],
  race: RaceState,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  signal?: AbortSignal,
) {
  const queries: Promise<unknown>[] = [];
  try {
    return await raceAll(
      candidates,
      race,
      config,
      dependencies,
      now,
      queries,
      signal,
    );
  } finally {
    await Promise.allSettled(queries);
  }
}
function raceAll(
  candidates: readonly SellerCandidate[],
  race: RaceState,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  queries: Promise<unknown>[],
  signal?: AbortSignal,
) {
  return raceControlOffers(
    candidates,
    (candidate, querySignal) => {
      const query = requestCandidate(
        candidate,
        race,
        config,
        dependencies,
        now,
        querySignal,
        signal,
      );
      queries.push(query);
      return query;
    },
    {
      signal,
      // The operator's selection.json wins over the caller's default.
      windowMs: config.quoteWindowMs ?? dependencies.windowMs,
      ...(config.previousSeller ? { preferred: config.previousSeller } : {}),
      // A seller silent for the whole window is cooled down like one that refused.
      onExpired: (pending) => {
        for (const candidate of pending) {
          dependencies.snapshots?.drop(candidate.nodeId);
          const retryAt = recordQuote(
            dependencies.stats,
            candidate.nodeId,
            false,
            0,
            now(),
            dependencies.backoff,
          );
          reportSellerFailure(dependencies.onSellerFailure, {
            nodeId: candidate.nodeId,
            phase: SELLER_FAILURE_PHASES.TIMEOUT,
            code: ERROR_DIAGNOSTICS.TIMEOUT,
            ...(retryAt ? { retryAt } : {}),
          });
        }
      },
    },
  );
}

// The candidate's connection: the one its snapshot was fetched on, or, for a snapshot remembered from an
// earlier request, a new one that starts from that verified catalog.
async function candidateClient(
  candidate: SellerCandidate,
  { clients, recalled, settling }: RaceState,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  querySignal: AbortSignal,
  signal?: AbortSignal,
) {
  const open = clients.get(candidate.nodeId);
  if (open) return { client: open, remembered: false };
  const seller = config.sellers.find(
    (item) =>
      item.nodeId === candidate.nodeId && item.owner === candidate.owner,
  );
  const catalog = recalled.get(candidate.nodeId);
  if (!seller || !catalog)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  querySignal.throwIfAborted();
  const client = await connectBefore(
    dependencies.connect(seller),
    querySignal,
    settling,
    signal,
    (work) => dependencies.snapshots?.retire(candidate.nodeId, work),
  );
  clients.set(candidate.nodeId, client);
  await client.useCatalog?.(catalog);
  return { client, remembered: true };
}
async function requestCandidate(
  candidate: SellerCandidate,
  race: RaceState,
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  querySignal: AbortSignal,
  // The caller's own signal: a cancelled request still waits for every connection it opened.
  signal?: AbortSignal,
) {
  const { clients, stale } = race;
  const start = now();
  const request = config.request;
  let remembered = false;
  try {
    const opened = await candidateClient(
      candidate,
      race,
      config,
      dependencies,
      querySignal,
      signal,
    );
    remembered = opened.remembered;
    const quote = await requestSized(
      opened.client,
      {
        buyer: dependencies.buyer,
        selection: request.selection,
        reasoning: candidate.reasoning,
        maxTokens: request.maxTokens,
        maxAtomic: candidate.free ? '0' : request.maxAtomic,
        priceCeilings: request.priceCeilings,
        network: request.network,
        asset: request.asset,
        ...(request.tools ? { tools: true as const } : {}),
      },
      { config, nodeId: candidate.nodeId, signal: querySignal },
    );
    if (querySignal.aborted)
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
    recordQuote(
      dependencies.stats,
      candidate.nodeId,
      true,
      now() - start,
      now(),
      dependencies.backoff,
    );
    return quote;
  } catch (error) {
    if (
      !querySignal.aborted &&
      (staleSellerCatalog(error) ||
        (remembered && CATALOG_CHANGED.has(sellerFailureCode(error))))
    ) {
      // A quote for a remembered catalog that the seller refused because it replaced the catalog or no
      // longer lists the model says the memory is out of date, not that the seller failed: it is asked
      // again with a fresh snapshot. Any other refusal counts as usual.
      dependencies.snapshots?.drop(candidate.nodeId);
      stale.add(candidate.nodeId);
      throw error;
    }
    releaseInBackground(race, candidate.nodeId, config, dependencies, signal);
    if (!querySignal.aborted) {
      // Its catalog may have changed or it may be gone: the next request verifies it again. A seller
      // that only lost the race keeps its snapshot.
      dependencies.snapshots?.drop(candidate.nodeId);
      const code = quoteFailureCode(error, request.tools === true);
      const retryAt = coolAfterQuote(code, candidate.nodeId, {
        dependencies,
        elapsedMs: now() - start,
        now: now(),
        signal,
      });
      reportSellerFailure(dependencies.onSellerFailure, {
        nodeId: candidate.nodeId,
        phase: SELLER_FAILURE_PHASES.QUOTE,
        code,
        ...(retryAt ? { retryAt } : {}),
      });
    }
    throw error;
  }
}
