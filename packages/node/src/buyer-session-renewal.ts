// Prepares replacement terms and finishes the previous channel before replacement authority begins.
import { verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import type { StartChannelWork } from './buyer-channel-prepare';
import { checkPreviousOpening } from './buyer-opening-state';
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
  if (!canRenew) {
    if (switching) throw new UnsentSellerBusyError(quote.offer.nodeId);
    return undefined;
  }
  if (opened.financial.snapshot().channelId)
    await opened.host.reconcile(signal);
  const snapshot = opened.financial.snapshot();
  if (
    !switching &&
    ((!snapshot.channelId && options.now() < opened.terms.expiresAt) ||
      (snapshot.state === SESSION_STATES.OPEN &&
        options.now() < opened.terms.expiresAt &&
        BigInt(snapshot.cumulativeAtomic) +
          BigInt(snapshot.reservedAtomic) +
          BigInt(quote.offer.maxAtomic) <=
          BigInt(opened.terms.depositAtomic)))
  )
    return undefined;
  const proposed = newSessionTerms(quote, options.policy, options.now());
  await verifyBatchQuote(
    quote,
    proposed,
    options.endpoint.id().toString(),
    options.now(),
  );
  const stored = await options.inspect();
  if (!stored || stored.pending) return sessionFail(SESSION_CODES.UNVERIFIED);
  const replacement = replacementTerms(
    options.policy,
    options.now,
    quote,
    stored.priorSpentAtomic,
  );
  if (snapshot.state !== SESSION_STATES.CLOSED)
    replacement(snapshot.cumulativeAtomic);
  const settlement = snapshot.channelId
    ? ((await opened.host.reconcile(signal)) ??
      (await start(() => opened.host.close(signal))))
    : undefined;
  const terms = replacement(settlement?.chargedAtomic ?? '0');
  await verifyBatchQuote(
    quote,
    terms,
    options.endpoint.id().toString(),
    options.now(),
  );
  signal.throwIfAborted();
  await opened.host.disconnect();
  await opened.host.settled();
  await opened.financial.dispose();
  return { channelId: snapshot.channelId, terms };
}
