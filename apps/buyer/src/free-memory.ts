// What one free buyer remembers in memory only, never on disk: the seller each recent conversation went to,
// and, within one selection, each seller's identity decision.
// The seller each recent conversation went to, so its next turn can go back while that seller's prompt
// cache may be warm. Keys are digests, kept in memory only and bounded; the oldest is forgotten first.
export function stickySellers(limit: number) {
  const sellers = new Map<string, string>();
  return {
    get: (key: string) => sellers.get(key),
    remember(key: string, nodeId: string) {
      sellers.delete(key);
      sellers.set(key, nodeId);
      if (sellers.size > limit)
        sellers.delete(sellers.keys().next().value as string);
    },
  };
}

// One selection checks each seller's registered identity once, however many steps ask (discovery, catalog,
// quote): a decision is kept for this selection only, and a check that threw (an abort, an outage that
// stops the request) is not kept.
export function onceEachSeller<
  Seller extends { nodeId: string; owner: string },
>(verify: (seller: Seller, signal?: AbortSignal) => Promise<boolean>) {
  const decided = new Map<string, boolean>();
  return async (seller: Seller, signal?: AbortSignal) => {
    const key = `${seller.nodeId} ${seller.owner}`;
    const known = decided.get(key);
    if (known !== undefined) return known;
    const ok = await verify(seller, signal);
    decided.set(key, ok);
    return ok;
  };
}
