// Only an active request's independently verified quote may bound fallback while its transport is occupied.
// This is price authority for the same listing only, never trust or execution authorization for a new request.
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import type { BuyerQuoteWinner } from './buyer-quote-execution';

// The exact listing one request prices (its selection, reasoning, network and asset), as an opaque key.
// A busy seller's price reference bounds another request's fallback only when both keys match.
export interface BuyerRouteScope {
  key: string;
}
export interface BuyerRouteSelection {
  // Host may ignore only a known busy cooldown while refreshing this exact queued seller.
  waitingFor?: string;
  pinnedNodeId?: string;
  priceCeilings: TokenPricesV2;
}

export function createRoutingReferences(now: () => number = Date.now) {
  const entries = new Map<
    string,
    {
      owner: symbol;
      // The listing the quote priced; only a request for that same listing may borrow it.
      key: string | undefined;
      issuedAt: number;
      expiresAt: number;
      prices: BuyerQuoteWinner['quote']['offer']['prices'];
    }
  >();
  return {
    remember(winner: BuyerQuoteWinner, owner: symbol, key?: string) {
      const offer = winner.quote.offer;
      entries.set(winner.nodeId, {
        owner,
        key,
        issuedAt: offer.issuedAt,
        expiresAt: offer.expiresAt,
        prices: { ...offer.prices },
      });
    },
    get(nodeId: string, owner: symbol | undefined, key?: string) {
      const entry = entries.get(nodeId);
      const current = now();
      return entry &&
        entry.owner === owner &&
        entry.key === key &&
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
