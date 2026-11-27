import type { HomeEnvironment } from '@gyblos/config/home';
import {
  batchPoolChannelPaths,
  batchPoolPathsIn,
  type BatchPoolPaths,
} from '@gyblos/config/home-payments';
import { bounded } from '@gyblos/node/buyer-operation';
import {
  batchSessionObserver,
  inspectBatchPool,
  inspectBatchSession,
  poolFundingPending,
} from '@gyblos/payments-upto/batch-session';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import {
  SESSION_CODES,
  SESSION_STATES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import type { ChannelBlocker } from './channel-blocker';

export type ObserveChannel = (
  paths: BatchPoolPaths['legacy'],
  terms: PaymentSessionTerms,
  channelId: string,
  signal: AbortSignal,
) => Promise<typeof SESSION_STATES.OPEN | typeof SESSION_STATES.CLOSED>;
export function observeChannelAt(rpcUrl: string): ObserveChannel {
  return (paths, terms, channelId, signal) =>
    batchSessionObserver({ paths, terms, rpcUrl }).status(channelId, signal);
}
interface Selection {
  payer: string;
  network: string;
  mint: string;
  nodeId: string;
  owner: string;
  maxAtomic?: string;
  requestId?: string;
  replacementAuthorized?: boolean;
  pinnedNodeId?: string;
  credentialBlocked?: boolean;
  activeRequest?(id: string): boolean;
}
export interface PaidChannelEligibility {
  channelId?: string;
  blocker: ChannelBlocker | null;
  channelRemainingAtomic: string | null;
}
function unavailable(blocker: ChannelBlocker | null): PaidChannelEligibility {
  return { blocker, channelRemainingAtomic: null };
}
function blocksPoolRequest(
  row: Awaited<ReturnType<typeof inspectBatchPool>>[number],
  selection: Selection,
) {
  if (!poolFundingPending(row)) return false;
  return (
    row.uncertain ||
    !row.requestId ||
    !selection.activeRequest?.(row.requestId) ||
    (row.terms.sellerNodeId === selection.nodeId &&
      row.requestId !== selection.requestId)
  );
}
export async function paidChannelEligibility(
  environment: HomeEnvironment,
  selection: Selection,
  now: () => number,
  observe: ObserveChannel,
  signal: AbortSignal,
): Promise<PaidChannelEligibility> {
  if (selection.credentialBlocked) return unavailable(BUYER_KEY_CODES.REVIEW);
  if (selection.pinnedNodeId && selection.pinnedNodeId !== selection.nodeId)
    return unavailable(SESSION_CODES.BINDING);
  const pool = batchPoolPathsIn(environment);
  try {
    const entries = await bounded(
      inspectBatchPool(pool, { includeLegacy: false }),
      signal,
    );
    if (entries.some((row) => blocksPoolRequest(row, selection)))
      return unavailable(SESSION_CODES.STATUS_UNKNOWN);
    const matching = entries.find(
      (entry) => entry.terms.sellerNodeId === selection.nodeId,
    );
    const paths =
      matching && !matching.legacy
        ? batchPoolChannelPaths(pool, selection.nodeId)
        : pool.legacy;
    const stored = entries.length
      ? matching?.stored
      : await bounded(inspectBatchSession(paths), signal);
    if (stored?.openingReturned)
      return unavailable(SESSION_CODES.OPENING_RETURNED);
    if (!stored || stored.empty || stored.notCreated) return unavailable(null);
    const { terms, snapshot } = stored;
    if (
      terms.network !== selection.network ||
      terms.buyer !== selection.payer ||
      terms.mint !== selection.mint
    )
      return unavailable(SESSION_CODES.BINDING);
    const switching = terms.sellerNodeId !== selection.nodeId;
    if (!switching && terms.owner !== selection.owner)
      return unavailable(SESSION_CODES.BINDING);
    if (stored.pending || stored.recoverable)
      return unavailable(SESSION_CODES.STATUS_UNKNOWN);
    if (snapshot.state === SESSION_STATES.CLOSED)
      return unavailable(
        stored.archivedProof
          ? SESSION_CODES.CLOSED
          : SESSION_CODES.STATUS_UNKNOWN,
      );
    if (now() >= terms.expiresAt) return unavailable(SESSION_CODES.EXPIRED);
    if (stored.openingPending || !snapshot.channelId)
      return unavailable(SESSION_CODES.STATUS_UNKNOWN);
    const current = await bounded(
      observe(paths, terms, snapshot.channelId, signal),
      signal,
    );
    if (current === SESSION_STATES.CLOSED)
      return unavailable(SESSION_CODES.CLOSED);
    if (now() >= terms.expiresAt) return unavailable(SESSION_CODES.EXPIRED);
    if (switching)
      return unavailable(
        selection.replacementAuthorized
          ? null
          : SESSION_CODES.REPLACEMENT_REQUIRED,
      );
    const remaining =
      BigInt(terms.depositAtomic) -
      BigInt(snapshot.cumulativeAtomic) -
      BigInt(snapshot.reservedAtomic);
    if (remaining < 0n) return unavailable(SESSION_CODES.STATUS_UNKNOWN);
    return {
      blocker:
        selection.maxAtomic && remaining < BigInt(selection.maxAtomic)
          ? SESSION_CODES.REPLACEMENT_REQUIRED
          : null,
      channelRemainingAtomic: String(remaining),
      channelId: snapshot.channelId,
    };
  } catch {
    return unavailable(SESSION_CODES.STATUS_UNKNOWN);
  }
}
