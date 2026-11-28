import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import type { HomeEnvironment } from '@gyblos/config/home';
import {
  batchPoolChannelPaths,
  batchPoolPathsIn,
  type BatchPoolPaths,
} from '@gyblos/config/home-payments';
import { bounded } from '@gyblos/node/buyer-operation';
import { desktopOpening } from '@gyblos/node/desktop-opening';
import {
  remainingDepositAuthority,
  type BuyerSessionPolicy,
} from '@gyblos/node/session-policy';
import {
  batchSessionObserver,
  inspectBatchPool,
  inspectBatchSession,
  poolFundingPending,
  type BatchStoredSession,
} from '@gyblos/payments-upto/batch-session';
import type {
  ChannelBlocker,
  PaidChannelEligibility,
} from '@gyblos/protocol/buyer-api';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import {
  SESSION_CODES,
  SESSION_STATES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

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
export async function sellerReplacementAuthorized(
  paidAuto: boolean,
  delegated: boolean,
  intent: string | undefined,
  armed = (id: string) => desktopOpening(process.env).armed(id),
) {
  if (delegated) return false;
  return intent ? armed(intent) : paidAuto;
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
  renewalPolicy?: Pick<
    BuyerSessionPolicy,
    'depositAtomic' | 'renewalBudgetAtomic'
  >;
  pinnedNodeId?: string;
  credentialBlocked?: boolean;
  activeRequest?(id: string, sellerNodeId: string): boolean;
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
    !row.requestId ||
    !selection.activeRequest?.(row.requestId, row.terms.sellerNodeId) ||
    (row.terms.sellerNodeId === selection.nodeId &&
      row.requestId !== selection.requestId)
  );
}
function remainingChannel(
  terms: PaymentSessionTerms,
  snapshot: import('@gyblos/protocol/payment-session').SessionSnapshot,
  maxAtomic?: string,
): PaidChannelEligibility {
  const remaining =
    BigInt(terms.depositAtomic) -
    BigInt(snapshot.cumulativeAtomic) -
    BigInt(snapshot.reservedAtomic);
  if (remaining < 0n) return unavailable(SESSION_CODES.STATUS_UNKNOWN);
  return {
    blocker:
      maxAtomic && remaining < BigInt(maxAtomic)
        ? SESSION_CODES.REPLACEMENT_REQUIRED
        : null,
    channelRemainingAtomic: String(remaining),
    channelId: snapshot.channelId ?? undefined,
  };
}
function selectedChannel(
  stored: BatchStoredSession,
  selection: Selection,
): PaidChannelEligibility {
  const { terms, snapshot } = stored;
  const result = remainingChannel(terms, snapshot, selection.maxAtomic);
  if (
    result.blocker === SESSION_CODES.REPLACEMENT_REQUIRED &&
    selection.renewalPolicy?.renewalBudgetAtomic &&
    !stored.openingPending &&
    snapshot.state === SESSION_STATES.OPEN &&
    snapshot.reservedAtomic === '0'
  ) {
    const deposit = remainingDepositAuthority(
      selection.renewalPolicy,
      stored.priorSpentAtomic,
      snapshot.cumulativeAtomic,
    );
    return {
      ...result,
      blocker: null,
      ...(!stored.renewalLimitReached &&
        deposit >= BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic) && {
          renewalDepositAtomic: String(deposit),
        }),
    };
  }
  return result;
}
function settledReplacement(
  stored: BatchStoredSession,
  policy: NonNullable<Selection['renewalPolicy']>,
): PaidChannelEligibility {
  const deposit = remainingDepositAuthority(
    policy,
    stored.priorSpentAtomic,
    stored.snapshot.cumulativeAtomic,
  );
  if (
    stored.renewalLimitReached ||
    deposit < BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic)
  )
    return unavailable(SESSION_CODES.REPLACEMENT_REQUIRED);
  return {
    blocker: null,
    channelRemainingAtomic: '0',
    renewalDepositAtomic: String(deposit),
  };
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
    if (
      !switching &&
      stored.settledPartial &&
      selection.renewalPolicy?.renewalBudgetAtomic
    )
      return settledReplacement(stored, selection.renewalPolicy);
    if (stored.pending || stored.recoverable)
      return unavailable(SESSION_CODES.STATUS_UNKNOWN);
    if (snapshot.state === SESSION_STATES.CLOSED)
      return unavailable(
        stored.archivedProof
          ? SESSION_CODES.CLOSED
          : SESSION_CODES.STATUS_UNKNOWN,
      );
    if (now() >= terms.expiresAt) return unavailable(SESSION_CODES.EXPIRED);
    if (!snapshot.channelId || (stored.openingPending && switching))
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
    return selectedChannel(stored, selection);
  } catch {
    return unavailable(SESSION_CODES.STATUS_UNKNOWN);
  }
}
