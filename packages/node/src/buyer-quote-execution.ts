// Routes an independently verified signed quote without reselecting inside either execution port.
// Only a proven-unsent attempt may return undefined; every other failure ends this request.
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { parseOfferV2 } from '@gyblos/protocol/offer-v2';

import { bounded } from './buyer-operation';
import { PaidBuyerError } from './buyer-paid-error';
import { BUYER_PAID_TIMEOUTS, PAID_BUYER_CODES } from './constants';

export interface BuyerQuoteWinner {
  nodeId: string;
  quote: SignedOfferV2;
}
export interface BuyerQuoteDependencies<T> {
  enter(): () => void;
  // Local-only, fail closed; unresolved signed payments block both modes, including after discard.
  unresolved(): Promise<boolean>;
  // This trusted port verifies identity, signatures, correlation, freshness and buyer policy.
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<BuyerQuoteWinner>;
  free(winner: BuyerQuoteWinner, signal: AbortSignal): Promise<T | undefined>;
  paid(winner: BuyerQuoteWinner, signal: AbortSignal): Promise<T | undefined>;
}
export function buyerQuoteKind(quote: SignedOfferV2) {
  const offer = parseOfferV2(quote.offer);
  const free =
    offer.prices.inputAtomicPerMtok === '0' &&
    offer.prices.outputAtomicPerMtok === '0';
  if (free !== (offer.maxAtomic === '0'))
    throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  return free ? OFFER_PRICING_KINDS.FREE : OFFER_PRICING_KINDS.PAID;
}
export async function executeBuyerQuote<T>(
  dependencies: BuyerQuoteDependencies<T>,
  external?: AbortSignal,
) {
  const release = dependencies.enter();
  const signal = AbortSignal.any([
    AbortSignal.timeout(BUYER_PAID_TIMEOUTS.requestMs),
    ...(external ? [external] : []),
  ]);
  try {
    const excluded = new Set<string>();
    while (!signal.aborted) {
      if (await bounded(dependencies.unresolved(), signal))
        throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
      signal.throwIfAborted();
      const winner = await bounded(
        dependencies.select(excluded, signal),
        signal,
      );
      signal.throwIfAborted();
      if (excluded.has(winner.nodeId)) break;
      excluded.add(winner.nodeId);
      const kind = buyerQuoteKind(winner.quote);
      const free = kind === OFFER_PRICING_KINDS.FREE;
      const result = await (free ? dependencies.free : dependencies.paid)(
        winner,
        signal,
      );
      signal.throwIfAborted();
      if (result !== undefined) return { kind, result };
    }
    signal.throwIfAborted();
    throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  } finally {
    release();
  }
}
