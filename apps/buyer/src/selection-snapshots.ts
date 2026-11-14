// Verified seller snapshots for one selection: each configured seller's signed catalog and presence,
// fetched in parallel within the snapshot deadline, and the local stats a failure updates.
import { SELLER_BADGES } from '@gyblos/core/constants';
import type { KnownSeller } from '@gyblos/core/seller-selection';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import { verifyPublicV2 } from '@gyblos/protocol/public-v2';

import {
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
  SELLER_FAILURE_PHASES,
  SELLER_FAILURES,
  type SellerFailurePhase,
} from './constants';
import type {
  BuyerControlClient,
  VerifiedSelectionDependencies,
} from './selection';
import { backoffFor, type SellerBackoff } from './selection-backoff';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';
import type { LocalSellerStats } from './selection-stats';
import {
  reportSellerFailure,
  sellerFailureCode,
  type SellerFailureCode,
} from './seller-failures';

// The seller's verified snapshot and the signed catalog it came from.
async function verifiedSnapshot(
  client: BuyerControlClient,
  seller: StaticControlSeller,
  now: () => number,
  signal: AbortSignal,
): Promise<{ known: KnownSeller; signed: SignedPublicV2 }> {
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
    signed,
    known: {
      catalog,
      presence,
      withdrawal,
      badge: SELLER_BADGES.DECLARED_USAGE,
      openChannel: false,
    },
  };
}
export async function verifiedSeller(
  client: BuyerControlClient,
  seller: StaticControlSeller,
  now: () => number,
  signal: AbortSignal,
): Promise<KnownSeller> {
  return (await verifiedSnapshot(client, seller, now, signal)).known;
}
// Returns the cooldown end a failure set (null after a success). With `backoff`, repeated failures cool
// a seller down longer each time (selection-backoff.ts); without it, always cooldownMs.
export function recordQuote(
  stats: Map<string, LocalSellerStats>,
  nodeId: string,
  success: boolean,
  latencyMs: number,
  now: number,
  backoff?: SellerBackoff,
) {
  const prior = stats.get(nodeId);
  if (success) backoff?.succeeded(nodeId);
  const cooldownUntil = success
    ? null
    : now + (backoff?.failed(nodeId) ?? BUYER_SELECTION.cooldownMs);
  stats.set(nodeId, {
    successes: (prior?.successes ?? 0) + Number(success),
    failures: (prior?.failures ?? 0) + Number(!success),
    latencyMs: Math.max(0, Math.round(latencyMs)),
    waitAccuracy: prior?.waitAccuracy ?? null,
    cooldownUntil,
    // v2 has no predicted wait and control latency is not inference waiting time.
    quotedWaitMs: prior?.quotedWaitMs ?? null,
    observedWaitMs: prior?.observedWaitMs ?? null,
  });
  return cooldownUntil;
}
function settledValues<T>(outcomes: PromiseSettledResult<T>[]) {
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

// A seller cooling down after a failure cannot win an automatic selection, so it is not contacted until
// the cooldown ends; a pinned one still is, so the caller can say when it returns. Selection reads the
// clock again after the snapshot, so only a cooldown that outlasts it counts.
function coolingPastSnapshot(
  seller: StaticControlSeller,
  dependencies: VerifiedSelectionDependencies,
  now: number,
) {
  const until = dependencies.stats.get(seller.nodeId)?.cooldownUntil;
  return (
    until != null &&
    until > now + (dependencies.snapshotMs ?? BUYER_SELECTION.snapshotMs)
  );
}

// A snapshot remembered from an earlier request, with its signed catalog kept for this selection.
function recall(
  dependencies: VerifiedSelectionDependencies,
  seller: StaticControlSeller,
  now: number,
  recalled: Map<string, SignedPublicV2>,
) {
  const cached = dependencies.snapshots?.get(seller, now);
  if (cached) recalled.set(seller.nodeId, cached.catalog);
  return cached?.known;
}

// Reports why this seller dropped out of the selection; a request the caller cancelled is not a seller
// failure.
function failureReporter(
  dependencies: VerifiedSelectionDependencies,
  seller: StaticControlSeller,
  signal?: AbortSignal,
) {
  return (
    phase: SellerFailurePhase,
    code: SellerFailureCode,
    retryAt?: number | null,
  ) => {
    if (!signal?.aborted)
      reportSellerFailure(dependencies.onSellerFailure, {
        nodeId: seller.nodeId,
        phase,
        code,
        ...(retryAt ? { retryAt } : {}),
      });
  };
}

// A seller that could not be reached or verified: its connection, which can take the whole transport idle
// timeout to close on a seller that stopped answering, closes in the background instead of holding the
// request (a cancelled request still waits for it, like any native work it started, and a pinned seller's
// close is awaited so its next connection never races this one for the per-peer limit). Its memory is
// dropped and it is cooled down; returns when it is tried again.
function connectFailed(
  seller: StaticControlSeller,
  {
    clients,
    config,
    dependencies,
    now,
  }: {
    clients: Map<string, BuyerControlClient>;
    config: BuyerSelectionConfig;
    dependencies: VerifiedSelectionDependencies;
    now: number;
  },
  pinned: boolean,
  signal?: AbortSignal,
) {
  const client = clients.get(seller.nodeId);
  if (client && !signal?.aborted && !pinned) {
    clients.delete(seller.nodeId);
    void client.close().catch(() => undefined);
  }
  dependencies.snapshots?.drop(seller.nodeId);
  return recordQuote(
    dependencies.stats,
    seller.nodeId,
    false,
    0,
    now,
    backoffFor(dependencies.backoff, config, seller.nodeId, signal),
  );
}

export async function refreshSnapshots(
  config: BuyerSelectionConfig,
  dependencies: VerifiedSelectionDependencies,
  clients: Map<string, BuyerControlClient>,
  // Remembered signed catalogs used by this selection, by NodeId, for its quotes.
  recalled: Map<string, SignedPublicV2>,
  now: () => number,
  deadline: AbortSignal,
  // The caller's own signal: its abort is a cancellation, while the snapshot deadline is a failure.
  signal?: AbortSignal,
) {
  return settledValues(
    await Promise.allSettled(
      config.sellers.map(async (seller) => {
        const pinned = seller.nodeId === config.pinnedNodeId;
        if (!pinned && coolingPastSnapshot(seller, dependencies, now()))
          return undefined;
        const failed = failureReporter(dependencies, seller, signal);
        try {
          if (
            dependencies.verifyIdentity &&
            !(await dependencies.verifyIdentity(seller, deadline))
          ) {
            failed(SELLER_FAILURE_PHASES.IDENTITY, SELLER_FAILURES.IDENTITY);
            return undefined;
          }
          // A snapshot verified on an earlier request and still current: no connection, no records asked.
          const cached = recall(dependencies, seller, now(), recalled);
          if (cached) return cached;
          deadline.throwIfAborted();
          const client = await connectBefore(
            dependencies.connect(seller),
            deadline,
            signal,
          );
          clients.set(seller.nodeId, client);
          const { known: verified, signed } = await verifiedSnapshot(
            client,
            seller,
            now,
            deadline,
          );
          if (
            dependencies.observeVerified &&
            !(await dependencies.observeVerified(verified))
          ) {
            failed(SELLER_FAILURE_PHASES.DISCOVERY, SELLER_FAILURES.DISCOVERY);
            return undefined;
          }
          dependencies.snapshots?.set(seller, verified, signed);
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
          const retryAt = connectFailed(
            seller,
            { clients, config, dependencies, now: now() },
            pinned,
            signal,
          );
          failed(
            SELLER_FAILURE_PHASES.CONNECT,
            sellerFailureCode(error),
            retryAt,
          );
          return undefined;
        }
      }),
    ),
  );
}

// A connection attempt ends with the snapshot deadline: a seller that stopped answering would otherwise
// hold every request for the whole transport timeout. A connection that arrives later is closed. A request
// the caller cancelled still waits for the attempt, so its admission stays held until native work settles.
async function connectBefore(
  connecting: Promise<BuyerControlClient>,
  deadline: AbortSignal,
  signal?: AbortSignal,
) {
  let stop = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    stop = () => {
      if (!signal?.aborted) reject(deadline.reason);
    };
    if (deadline.aborted) stop();
    else deadline.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([connecting, expired]);
  } catch (error) {
    void connecting.then(
      (client) => client.close().catch(() => undefined),
      () => undefined,
    );
    throw error;
  } finally {
    deadline.removeEventListener('abort', stop);
  }
}
