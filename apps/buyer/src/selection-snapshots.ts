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
export function recordQuote(
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
        // A request the caller cancelled is not a seller failure.
        const failed = (phase: SellerFailurePhase, code: SellerFailureCode) => {
          if (!signal?.aborted)
            reportSellerFailure(dependencies.onSellerFailure, {
              nodeId: seller.nodeId,
              phase,
              code,
            });
        };
        try {
          if (
            dependencies.verifyIdentity &&
            !(await dependencies.verifyIdentity(seller, deadline))
          ) {
            failed(SELLER_FAILURE_PHASES.IDENTITY, SELLER_FAILURES.IDENTITY);
            return undefined;
          }
          // A snapshot verified on an earlier request and still current: no connection, no records asked.
          const cached = dependencies.snapshots?.get(seller, now());
          if (cached) {
            recalled.set(seller.nodeId, cached.catalog);
            return cached.known;
          }
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
          // A connection to a seller that stopped answering can take the whole transport idle timeout to
          // close; it closes in the background instead of holding this request. A cancelled request
          // still waits for it, like any native work it started.
          // A pinned seller is asked again on the next request, so its close is still awaited: a new
          // connection never races one still closing for the seller's per-peer limit.
          const client = clients.get(seller.nodeId);
          if (client && !signal?.aborted && !pinned) {
            clients.delete(seller.nodeId);
            void client.close().catch(() => undefined);
          }
          dependencies.snapshots?.drop(seller.nodeId);
          recordQuote(dependencies.stats, seller.nodeId, false, 0, now());
          failed(SELLER_FAILURE_PHASES.CONNECT, sellerFailureCode(error));
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
