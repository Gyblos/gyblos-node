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

import {
  BUYER_DISCOVERY,
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
} from './constants';
import type { BuyerDiscoveryConfig } from './discovery-config';
import type { BuyerDiscoveryState } from './discovery-storage';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';

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
// A seller the index lists but this buyer never configured, admitted only under open discovery, only when
// its NodeId is registered to the catalog's owner, and only while the candidate list has room (the
// configured sellers come first). It is dialed through the configured relay, never an index address.
async function openSeller(
  entry: DiscoveredSeller,
  config: BuyerSelectionConfig & { discovery: BuyerDiscoveryConfig },
  options: {
    verifyIdentity?: (
      seller: StaticControlSeller,
      signal?: AbortSignal,
    ) => Promise<boolean>;
    openRelay?: string;
  },
  discovered: Map<string, StaticControlSeller>,
  signal: AbortSignal,
): Promise<StaticControlSeller | undefined> {
  const known = discovered.get(entry.catalog.nodeId);
  if (known) return known;
  if (
    !config.discovery.open ||
    !config.identity ||
    !options.verifyIdentity ||
    !options.openRelay ||
    config.sellers.length + discovered.size >= BUYER_SELECTION.maxSellers
  )
    return undefined;
  const seller: StaticControlSeller = {
    owner: entry.catalog.owner,
    nodeId: entry.catalog.nodeId,
    relayUrl: options.openRelay,
    directAddresses: [],
  };
  if (!(await options.verifyIdentity(seller, signal))) return undefined;
  discovered.set(seller.nodeId, seller);
  return seller;
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
    // The relay a seller found only in the index is dialed through (open discovery); the caller's,
    // so this module never loads the transport.
    openRelay?: string;
  },
): Promise<BuyerSelectionConfig> {
  const now = options.now ?? Date.now;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? BUYER_DISCOVERY.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
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
  // Sellers known only from the index (open discovery), each with a verified registered identity.
  const discovered = new Map<string, StaticControlSeller>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < config.discovery.maxPages; page++) {
    signal.throwIfAborted();
    // Keep equal-sequence entries visible for digest comparison. The persistent store enforces
    // the high-water mark and retains live candidate IDs when the index repeats a held presence.
    const result = await fetchSellers({
      baseUrl: config.discovery.baseUrl,
      model: config.request.selection.modelId,
      fetch: options.fetch,
      now,
      signal,
      timeoutMs: options.timeoutMs ?? BUYER_DISCOVERY.timeoutMs,
      limit: BUYER_DISCOVERY.pageSize,
      cursor,
    });
    signal.throwIfAborted();
    for (const entry of result.sellers) {
      const trusted =
        identities.get(entry.catalog.nodeId) ??
        (await openSeller(entry, config, options, discovered, signal));
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
  return eligibleConfig(
    config,
    state,
    [...accepted, ...discovered.values()],
    now(),
  );
}

// The configured and discovered sellers whose remembered catalog and presence are still eligible.
function eligibleConfig(
  config: BuyerSelectionConfig,
  state: BuyerDiscoveryState,
  candidates: StaticControlSeller[],
  now: number,
): BuyerSelectionConfig {
  const eligible = new Set(
    state.eligible(candidates, now).map((seller) => seller.nodeId),
  );
  const configured = new Set(config.sellers.map((seller) => seller.nodeId));
  return {
    ...config,
    sellers: [
      ...config.sellers,
      ...candidates.filter((seller) => !configured.has(seller.nodeId)),
    ].filter((seller) => eligible.has(seller.nodeId)),
  };
}
