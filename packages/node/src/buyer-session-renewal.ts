// Prepares replacement terms and finishes the previous channel before replacement authority begins.
import {
  matchBatchTerms,
  verifyBatchQuote,
} from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  UnsentChannelLimitError,
  type PaymentSessionTerms,
  type SessionSnapshot,
} from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import {
  UnsentChannelRequestError,
  UnsentSellerChoiceError,
  type StartChannelWork,
} from './buyer-channel-prepare';
import { checkPreviousOpening, disconnectChannel } from './buyer-opening-state';
import { bounded } from './buyer-operation';
import { UnsentSellerBusyError } from './buyer-routing';
import type { Current, State } from './buyer-session';
import { newSessionTerms, replacementTerms } from './session-policy';

export async function prepareRenewal<Remote extends BatchDestination>(
  state: State<Remote>,
  opened: Current<Remote>,
  quote: SignedOfferV2,
  signal: AbortSignal,
  switching: boolean,
  canRenew: boolean,
  start: StartChannelWork,
) {
  const options = state.options;
  if (
    (await checkPreviousOpening(state, opened, signal)) &&
    !switching &&
    options.now() < opened.terms.expiresAt
  )
    return undefined;
  if (!canRenew && options.policy.renewalBudgetAtomic === undefined) {
    if (switching) throw new UnsentSellerBusyError(quote.offer.nodeId);
    return undefined;
  }
  if (opened.financial.snapshot().channelId)
    await opened.host.reconcile(signal);
  const snapshot = opened.financial.snapshot();
  if (
    !switching &&
    canUseCurrent(opened.terms, snapshot, quote.offer.maxAtomic, options.now())
  )
    return undefined;
  if (snapshot.channelId) await options.checkReusableChannel?.(quote, signal);
  if (options.policy.fundedChannelId)
    throw new UnsentSellerChoiceError(
      SESSION_CODES.REPLACEMENT_REQUIRED,
      quote.offer.nodeId,
    );
  const proposed = newSessionTerms(quote, options.policy, options.now());
  const stored = await options.inspect();
  if (options.policy.renewalBudgetAtomic !== undefined)
    checkRenewalTerms(
      opened.terms,
      proposed,
      snapshot,
      options.now(),
      switching,
      canRenew,
      stored?.settledPartial === true,
    );
  const verify = (terms: PaymentSessionTerms) =>
    verifyReplacementQuote(state, quote, terms);
  await verify(proposed);
  if (!stored || stored.pending) return sessionFail(SESSION_CODES.UNVERIFIED);
  if (stored.renewalLimitReached)
    throw new UnsentChannelLimitError(quote.offer.nodeId);
  const replacement = replacementTerms(
    options.policy,
    options.now,
    quote,
    stored.priorSpentAtomic,
  );
  if (options.policy.renewalBudgetAtomic !== undefined) {
    const expected = replacement(snapshot.cumulativeAtomic);
    await checkWallet(state, opened, expected, signal);
  }
  const settlement = snapshot.channelId
    ? ((await opened.host.reconcile(signal)) ??
      (await start(() => opened.host.close(signal))))
    : undefined;
  const terms = replacement(settlement?.chargedAtomic ?? '0');
  signal.throwIfAborted();
  await disconnectChannel(opened);
  return {
    channelId: snapshot.channelId,
    terms,
    verify: () => verify(terms),
  };
}

async function verifyReplacementQuote<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  terms: PaymentSessionTerms,
) {
  try {
    await verifyBatchQuote(
      quote,
      terms,
      state.options.endpoint.id().toString(),
      state.options.now(),
    );
  } catch (error) {
    throw new UnsentChannelRequestError(quote.offer.nodeId, error);
  }
}

function canUseCurrent(
  terms: PaymentSessionTerms,
  snapshot: SessionSnapshot,
  maximum: string,
  now: number,
) {
  if (now >= terms.expiresAt) return false;
  if (!snapshot.channelId) return true;
  return (
    snapshot.state === SESSION_STATES.OPEN &&
    BigInt(snapshot.cumulativeAtomic) +
      BigInt(snapshot.reservedAtomic) +
      BigInt(maximum) <=
      BigInt(terms.depositAtomic)
  );
}

function checkRenewalTerms(
  previous: PaymentSessionTerms,
  proposed: PaymentSessionTerms,
  snapshot: SessionSnapshot,
  now: number,
  switching: boolean,
  canRenew: boolean,
  settledPartial: boolean,
) {
  if (
    !canRenew ||
    switching ||
    (snapshot.state !== SESSION_STATES.OPEN &&
      !(settledPartial && snapshot.state === SESSION_STATES.CLOSED)) ||
    snapshot.reservedAtomic !== '0'
  )
    throw new UnsentSellerChoiceError(
      SESSION_CODES.STATUS_UNKNOWN,
      proposed.sellerNodeId,
    );
  if (now >= previous.expiresAt)
    throw new UnsentSellerChoiceError(
      SESSION_CODES.EXPIRED,
      proposed.sellerNodeId,
    );
  try {
    matchBatchTerms(proposed, {
      ...previous,
      depositAtomic: proposed.depositAtomic,
      expiresAt: proposed.expiresAt,
    });
  } catch {
    throw new UnsentSellerChoiceError(
      SESSION_CODES.BINDING,
      proposed.sellerNodeId,
    );
  }
}

async function checkWallet<Remote extends BatchDestination>(
  state: State<Remote>,
  opened: Current<Remote>,
  next: PaymentSessionTerms,
  signal: AbortSignal,
) {
  const previous = opened.terms;
  const snapshot = opened.financial.snapshot();
  const backend = await state.backend;
  const available = await bounded(
    backend?.availableBalance?.(previous, signal) ?? Promise.resolve(null),
    signal,
  ).catch(() => null);
  signal.throwIfAborted();
  if (available === null)
    throw new UnsentSellerChoiceError(
      SESSION_CODES.STATUS_UNKNOWN,
      next.sellerNodeId,
    );
  const refundable =
    snapshot.state === SESSION_STATES.CLOSED
      ? 0n
      : BigInt(previous.depositAtomic) - BigInt(snapshot.cumulativeAtomic);
  if (BigInt(available) + refundable < BigInt(next.depositAtomic))
    throw new UnsentChannelLimitError(next.sellerNodeId);
}
