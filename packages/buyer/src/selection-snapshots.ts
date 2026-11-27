// Verified seller snapshots for one selection: each configured seller's signed catalog and presence,
// fetched in parallel within the snapshot deadline, and the local stats a failure updates.

import { SELLER_BADGES } from '@gyblos/core/constants';
import type { KnownSeller } from '@gyblos/core/seller-selection';
import { CONTROL_CODES, PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
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
import type { SellerBackoff } from './selection-backoff';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';
import type { LocalSellerStats } from './selection-stats';
import {
  sellerFailureCode as failureCode,
  reportSellerFailure,
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
// Record quote stats and return their cooldown end (null after a success).
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
  const measured = Math.max(0, Math.round(latencyMs));
  stats.set(nodeId, {
    successes: (prior?.successes ?? 0) + Number(success),
    failures: (prior?.failures ?? 0) + Number(!success),
    latencyMs: success ? measured : (prior?.latencyMs ?? null),
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

// Skip only unpinned cooldowns that outlast the snapshot; recheck expiry afterward.
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

// A failed connection closes in the background unless pinned or cancelled. Retain its native work,
// drop the snapshot and record the cooldown returned to failure diagnostics.
function connectFailed(
  seller: StaticControlSeller,
  clients: Map<string, BuyerControlClient>,
  settling: Promise<unknown>[],
  { stats, snapshots, backoff }: VerifiedSelectionDependencies,
  now: number,
  pinned: boolean,
  signal?: AbortSignal,
) {
  const client = clients.get(seller.nodeId);
  if (client && !signal?.aborted && !pinned) {
    clients.delete(seller.nodeId);
    const closing = client.close().catch(() => undefined);
    settling.push(closing);
    snapshots?.retire(seller.nodeId, closing);
  }
  snapshots?.drop(seller.nodeId);
  return recordQuote(stats, seller.nodeId, false, 0, now, backoff);
}

type SnapshotDependencies = VerifiedSelectionDependencies & {
  renewing?: Set<string>;
};

export async function refreshSnapshots(
  config: BuyerSelectionConfig,
  dependencies: SnapshotDependencies,
  clients: Map<string, BuyerControlClient>,
  // Remembered signed catalogs used by this selection, by NodeId, for its quotes.
  recalled: Map<string, SignedPublicV2>,
  now: () => number,
  deadline: AbortSignal,
  settling: Promise<unknown>[],
  signal?: AbortSignal,
) {
  const skipped = new Set<StaticControlSeller>();
  const batch = (
    sellers: StaticControlSeller[],
    end: AbortSignal,
    skippedSellers: Set<StaticControlSeller>,
  ) =>
    snapshotBatch(
      { ...config, sellers },
      dependencies,
      clients,
      recalled,
      now,
      end,
      settling,
      skippedSellers,
      signal,
    );
  const snapshots = await batch(config.sellers, deadline, skipped);
  // Identity and durable discovery work may settle after the nominal snapshot deadline. A seller
  // skipped earlier must still be considered if its cooldown ended before selection actually runs.
  while (!signal?.aborted) {
    const recovered = [...skipped].filter((seller) => {
      const until = dependencies.stats.get(seller.nodeId)?.cooldownUntil;
      return until == null || until <= now();
    });
    if (!recovered.length) break;
    for (const seller of recovered) skipped.delete(seller);
    const nextDeadline = AbortSignal.any([
      AbortSignal.timeout(
        dependencies.snapshotMs ?? BUYER_SELECTION.snapshotMs,
      ),
      ...(signal ? [signal] : []),
    ]);
    snapshots.push(...(await batch(recovered, nextDeadline, new Set())));
  }
  return snapshots;
}

// Identity remains per request. Cached work is reusable only while no native retirement is pending
// and durable discovery still permits the snapshot; a superseded record is fetched before filtering.
async function beforeSnapshot(
  seller: StaticControlSeller,
  dependencies: VerifiedSelectionDependencies,
  now: () => number,
  deadline: AbortSignal,
  recalled: Map<string, SignedPublicV2>,
  failed: ReturnType<typeof failureReporter>,
): Promise<{ complete: boolean; known?: KnownSeller }> {
  if (
    dependencies.verifyIdentity &&
    !(await dependencies.verifyIdentity(seller, deadline))
  ) {
    failed(SELLER_FAILURE_PHASES.IDENTITY, SELLER_FAILURES.IDENTITY);
    return { complete: true };
  }
  if (dependencies.snapshots?.retiring(seller.nodeId))
    return { complete: true };
  const cached = recall(dependencies, seller, now(), recalled);
  if (!cached) return { complete: false };
  if (
    !dependencies.observeVerified ||
    (await dependencies.observeVerified(cached))
  )
    return { complete: true, known: cached };
  dependencies.snapshots?.drop(seller.nodeId);
  recalled.delete(seller.nodeId);
  return { complete: false };
}

// The fresh signed records still pass durable discovery before entering reusable memory.
async function freshSnapshot(
  client: BuyerControlClient,
  seller: StaticControlSeller,
  dependencies: SnapshotDependencies,
  now: () => number,
  deadline: AbortSignal,
  failed: ReturnType<typeof failureReporter>,
) {
  const snapshot = await verifiedSnapshot(client, seller, now, deadline);
  const { known, signed } = snapshot;
  if (
    dependencies.observeVerified &&
    !(await dependencies.observeVerified(known))
  ) {
    failed(SELLER_FAILURE_PHASES.DISCOVERY, SELLER_FAILURES.DISCOVERY);
    return undefined;
  }
  dependencies.snapshots?.set(seller, known, signed);
  return known;
}

function forgetStale(dependencies: SnapshotDependencies, nodeId: string) {
  dependencies.renewing?.add(nodeId);
  dependencies.snapshots?.drop(nodeId);
  return null;
}
async function snapshotBatch(
  config: BuyerSelectionConfig,
  dependencies: SnapshotDependencies,
  clients: Map<string, BuyerControlClient>,
  recalled: Map<string, SignedPublicV2>,
  now: () => number,
  deadline: AbortSignal,
  settling: Promise<unknown>[],
  skipped: Set<StaticControlSeller>,
  // The caller's own signal: its abort is a cancellation, while the snapshot deadline is a failure.
  signal?: AbortSignal,
) {
  return settledValues(
    await Promise.allSettled(
      config.sellers.map(async (seller) => {
        const pinned = seller.nodeId === config.pinnedNodeId;
        if (!pinned && coolingPastSnapshot(seller, dependencies, now())) {
          skipped.add(seller);
          return undefined;
        }
        const failed = failureReporter(dependencies, seller, signal);
        try {
          const remembered = await beforeSnapshot(
            seller,
            dependencies,
            now,
            deadline,
            recalled,
            failed,
          );
          if (remembered.complete) return remembered.known;
          deadline.throwIfAborted();
          const client = await connectBefore(
            dependencies.connect(seller),
            deadline,
            settling,
            signal,
            (work) => dependencies.snapshots?.retire(seller.nodeId, work),
          );
          clients.set(seller.nodeId, client);
          return await freshSnapshot(
            client,
            seller,
            dependencies,
            now,
            deadline,
            failed,
          );
        } catch (error) {
          if (
            error instanceof BuyerSelectionError &&
            [
              BUYER_SELECTION_CODES.DISCOVERY_STATE,
              BUYER_SELECTION_CODES.IDENTITY_STATE,
            ].some((code) => error.code === code)
          )
            throw error;
          const code = failureCode(error);
          const retryAt =
            code === CONTROL_CODES.STALE
              ? forgetStale(dependencies, seller.nodeId)
              : connectFailed(
                  seller,
                  clients,
                  settling,
                  dependencies,
                  now(),
                  pinned,
                  signal,
                );
          failed(SELLER_FAILURE_PHASES.CONNECT, code, retryAt);
          return undefined;
        }
      }),
    ),
  );
}

// Bound dialing by the snapshot deadline and close late connections. Cancellation
// still owns the native attempt until it settles, keeping admission held.
export async function connectBefore(
  connecting: Promise<BuyerControlClient>,
  deadline: AbortSignal,
  settling: Promise<unknown>[],
  signal?: AbortSignal,
  retire?: (work: Promise<unknown>) => void,
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
    const closing = connecting.then(
      (client) => client.close().catch(() => undefined),
      () => undefined,
    );
    settling.push(closing);
    retire?.(closing);
    throw error;
  } finally {
    deadline.removeEventListener('abort', stop);
  }
}
