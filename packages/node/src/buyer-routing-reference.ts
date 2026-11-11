// Only an active request's independently verified quote may bound fallback while its transport is occupied.
// This is price authority, never trust or execution authorization for a new request.
import type { BuyerQuoteWinner } from './buyer-quote-execution';

export function createRoutingReferences(now: () => number = Date.now) {
  const entries = new Map<
    string,
    {
      owner: symbol;
      issuedAt: number;
      expiresAt: number;
      prices: BuyerQuoteWinner['quote']['offer']['prices'];
    }
  >();
  return {
    remember(winner: BuyerQuoteWinner, owner: symbol) {
      const offer = winner.quote.offer;
      entries.set(winner.nodeId, {
        owner,
        issuedAt: offer.issuedAt,
        expiresAt: offer.expiresAt,
        prices: { ...offer.prices },
      });
    },
    get(nodeId: string, owner: symbol | undefined) {
      const entry = entries.get(nodeId);
      const current = now();
      return entry &&
        entry.owner === owner &&
        entry.issuedAt <= current &&
        current < entry.expiresAt
        ? { ...entry.prices }
        : undefined;
    },
    clear(nodeId: string, owner: symbol) {
      if (entries.get(nodeId)?.owner === owner) entries.delete(nodeId);
    },
  };
}
