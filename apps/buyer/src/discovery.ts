// Collects bounded HTTP discovery hints for operator-trusted identities, persisting replay checks.
// Only candidate IDs survive: fresh signed Iroh verification still precedes selection and quotes.
import { SELLER_BADGES } from '@gyblos/core/constants';
import {
  fetchSellers,
  type DiscoveredSeller,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import { verifyPublicV2 } from '@gyblos/protocol/public-v2';

import { BUYER_DISCOVERY, BUYER_SELECTION_CODES } from './constants.js';
import type { BuyerDiscoveryConfig } from './discovery-config.js';
import type { BuyerDiscoveryState } from './discovery-storage.js';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config.js';

async function rememberEntry(
  entry: DiscoveredSeller,
  trusted: StaticControlSeller,
  state: BuyerDiscoveryState,
  now: number,
  allowOwnerChange: boolean,
) {
  const withdrawal = trusted.withdrawal
    ? await verifyPublicV2(trusted.withdrawal, {
        owner: trusted.owner,
        nodeId: trusted.nodeId,
        now,
        catalog: entry.catalog,
      })
    : null;
  if (withdrawal && withdrawal.kind !== PUBLIC_RECORD_KINDS.WITHDRAWAL)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.INVALID);
  await state.observe(
    {
      ...entry,
      withdrawal,
      badge: SELLER_BADGES.DECLARED_USAGE,
      openChannel: false,
    },
    { allowOwnerChange },
  );
}
export async function discoverBuyerSellers(
  config: BuyerSelectionConfig & { discovery: BuyerDiscoveryConfig },
  state: BuyerDiscoveryState,
  options: {
    fetch: DiscoveryFetch;
    now?: () => number;
    signal?: AbortSignal;
    timeoutMs?: number;
    verifyIdentity?: (
      seller: StaticControlSeller,
      signal?: AbortSignal,
    ) => Promise<boolean>;
  },
): Promise<BuyerSelectionConfig> {
  const now = options.now ?? Date.now;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? BUYER_DISCOVERY.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetch = options.fetch;
  if (config.identity && !options.verifyIdentity)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.IDENTITY);
  const accepted = [];
  for (const seller of config.sellers) {
    signal.throwIfAborted();
    if (
      !options.verifyIdentity ||
      (await options.verifyIdentity(seller, signal))
    )
      accepted.push(seller);
    signal.throwIfAborted();
  }
  const identities = new Map(accepted.map((seller) => [seller.nodeId, seller]));
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < config.discovery.maxPages; page++) {
    signal.throwIfAborted();
    // Keep equal-sequence entries visible for digest comparison. The persistent store enforces
    // the high-water mark and retains live candidate IDs when the index repeats a held presence.
    const result = await fetchSellers({
      baseUrl: config.discovery.baseUrl,
      model: config.request.selection.modelId,
      fetch,
      now,
      signal,
      timeoutMs: options.timeoutMs ?? BUYER_DISCOVERY.timeoutMs,
      limit: BUYER_DISCOVERY.pageSize,
      cursor,
    });
    signal.throwIfAborted();
    for (const entry of result.sellers) {
      const trusted = identities.get(entry.catalog.nodeId);
      if (trusted?.owner !== entry.catalog.owner) continue;
      await rememberEntry(
        entry,
        trusted,
        state,
        now(),
        Boolean(config.identity),
      );
      signal.throwIfAborted();
    }
    if (result.next === null) break;
    if (cursors.has(result.next) || page + 1 >= config.discovery.maxPages)
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_LIMIT);
    cursors.add(result.next);
    cursor = result.next;
  }
  signal.throwIfAborted();
  const eligible = new Set(
    state.eligible(accepted, now()).map((seller) => seller.nodeId),
  );
  return {
    ...config,
    sellers: config.sellers.filter((seller) => eligible.has(seller.nodeId)),
  };
}
