// Collects bounded HTTP discovery hints for operator-configured identities and, under open discovery,
// registry-verified sellers found only in the index, persisting replay checks.
// Only candidate IDs survive: fresh signed Iroh verification still precedes selection and quotes.
import { randomInt } from 'node:crypto';

import { SELLER_BADGES } from '@gyblos/core/constants';
import {
  servesRequest,
  type SellerRequest,
} from '@gyblos/core/seller-selection';
import {
  fetchSellers,
  supersedes,
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
import { readIndexPages } from './discovery-pages';
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
interface OpenMemory {
  refused: Map<string, number>;
}
const OPEN_MEMORY = new WeakMap<object, OpenMemory>();
function openMemory(state: object) {
  let memory = OPEN_MEMORY.get(state);
  if (!memory) OPEN_MEMORY.set(state, (memory = { refused: new Map() }));
  return memory;
}

interface OpenOptions {
  verifyIdentity?: (
    seller: StaticControlSeller,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  openRelay?: string;
  excluded?: ReadonlySet<string>;
}
interface OpenRun {
  discovered: Map<string, StaticControlSeller>;
  memory: OpenMemory;
  lookups: number;
  now: number;
}

// A seller the index lists but this buyer never configured, admitted only under open discovery,
// only when its NodeId is registered to the catalog's owner, only
// while the candidate list has room (the configured sellers come first), never one this request
// excluded, and within the lookup and process bounds. It is dialed through the configured relay, never an
// index address.
async function openSeller(
  entry: DiscoveredSeller,
  config: BuyerSelectionConfig & { discovery: BuyerDiscoveryConfig },
  options: OpenOptions,
  run: OpenRun,
  signal: AbortSignal,
): Promise<StaticControlSeller | undefined> {
  const { nodeId, owner } = entry.catalog;
  const key = `${nodeId} ${owner}`;
  if (
    !config.discovery.open ||
    !config.identity ||
    !options.verifyIdentity ||
    !options.openRelay ||
    options.excluded?.has(nodeId) ||
    config.sellers.length + run.discovered.size >= BUYER_SELECTION.maxSellers ||
    (run.memory.refused.get(key) ?? 0) > run.now ||
    run.lookups >= BUYER_DISCOVERY.openLookups
  )
    return undefined;
  const seller: StaticControlSeller = {
    owner,
    nodeId,
    relayUrl: options.openRelay,
    directAddresses: [],
  };
  run.lookups++;
  if (!(await options.verifyIdentity(seller, signal))) {
    if (run.memory.refused.size >= BUYER_DISCOVERY.openRefusals)
      run.memory.refused.delete(run.memory.refused.keys().next().value!);
    run.memory.refused.set(key, run.now + BUYER_DISCOVERY.openRefusalMs);
    return undefined;
  }
  run.discovered.set(nodeId, seller);
  return seller;
}

// `openRelay`: the relay a seller found only in the index is dialed through (open discovery), passed by
// the caller so this module never loads the transport; absent, open discovery adds nobody. `excluded`:
// NodeIds this request already tried, never brought back from the index.
export interface DiscoverOptions extends OpenOptions {
  fetch: DiscoveryFetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  // A value in [0, 1): the order sellers found only in the index are looked up in. Defaults to crypto.
  random?: () => number;
}

// Every page of the index's sellers of this request's model, up to the configured page bound.
async function readAllPages(
  config: BuyerSelectionConfig & { discovery: BuyerDiscoveryConfig },
  options: DiscoverOptions,
  now: () => number,
  signal: AbortSignal,
) {
  const read = async (cursor: string | undefined) => {
    signal.throwIfAborted();
    // Keep equal-sequence entries visible for digest comparison: a fork across pages reaches the store
    // through every remembered entry of a trusted seller (within one page the client keeps one entry per
    // NodeId). The persistent store enforces
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
    return result;
  };
  return readIndexPages(
    read,
    config.discovery.maxPages,
    options.random ?? cryptoRandom,
  );
}

// A NodeId the index lists: its newest entry, and every entry in index order. Once its identity is
// confirmed, every entry under that owner is remembered, so a same-sequence fork across pages is caught.
interface Listing {
  newest: DiscoveredSeller;
  entries: DiscoveredSeller[];
}
// The sellers found only in the index whose newest entry could serve this request (every hard filter),
// one place per NodeId: `preferred` first (the conversation's previous and warm sellers), then the rest in
// a random order, so which of them get the bounded identity lookups never depends on the index's order or
// on how often it lists one.
function drawOpen(
  entries: DiscoveredSeller[],
  request: SellerRequest,
  now: number,
  random: () => number,
  preferred: ReadonlySet<string>,
) {
  const listings = new Map<string, Listing>();
  for (const entry of entries) {
    const held = listings.get(entry.catalog.nodeId);
    if (!held)
      listings.set(entry.catalog.nodeId, { newest: entry, entries: [entry] });
    else {
      held.entries.push(entry);
      if (supersedes(entry, held.newest)) held.newest = entry;
    }
  }
  const drawn = [...listings.values()].filter(({ newest }) =>
    servesRequest(
      request,
      {
        ...newest,
        badge: SELLER_BADGES.DECLARED_USAGE,
        openChannel: false,
      },
      now,
    ),
  );
  for (let index = drawn.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [drawn[index], drawn[other]] = [drawn[other]!, drawn[index]!];
  }
  const first = ({ newest }: Listing) => preferred.has(newest.catalog.nodeId);
  return [
    ...drawn.filter(first),
    ...drawn.filter((listing) => !first(listing)),
  ];
}
// The sellers this conversation reached before: the previous one and the one still holding it warm.
const conversationSellers = (config: BuyerSelectionConfig) =>
  new Set(
    [config.previousSeller, config.warmSeller].filter(
      (nodeId) => nodeId !== undefined,
    ),
  );
const cryptoRandom = () =>
  randomInt(BUYER_SELECTION.randomRange) / BUYER_SELECTION.randomRange;
async function verifiedConfiguredSellers(
  config: BuyerSelectionConfig,
  options: DiscoverOptions,
  signal: AbortSignal,
) {
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
  return accepted;
}
export async function discoverBuyerSellers(
  config: BuyerSelectionConfig & { discovery: BuyerDiscoveryConfig },
  state: BuyerDiscoveryState,
  options: DiscoverOptions,
): Promise<BuyerSelectionConfig> {
  const now = options.now ?? Date.now;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? BUYER_DISCOVERY.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const accepted = await verifiedConfiguredSellers(config, options, signal);
  const identities = new Map(accepted.map((seller) => [seller.nodeId, seller]));
  // Sellers known only from the index (open discovery), each with a verified registered identity.
  const run: OpenRun = {
    discovered: new Map(),
    memory: openMemory(state),
    lookups: 0,
    now: now(),
  };
  const entries = await readAllPages(config, options, now, signal);
  // Index entries of configured sellers first, then the open ones, drawn. A configured seller whose
  // identity check failed is never looked up again as an open one under the index's owner.
  const configured = new Set(config.sellers.map((seller) => seller.nodeId));
  const open: DiscoveredSeller[] = [];
  for (const entry of entries) {
    if (
      config.discovery?.paidAuto &&
      config.pinnedNodeId &&
      entry.catalog.nodeId !== config.pinnedNodeId
    )
      continue;
    const trusted = identities.get(entry.catalog.nodeId);
    if (!trusted) {
      if (!configured.has(entry.catalog.nodeId)) open.push(entry);
    } else if (trusted.owner === entry.catalog.owner)
      await rememberEntry(
        entry,
        trusted,
        state,
        now(),
        Boolean(config.identity),
      );
    signal.throwIfAborted();
  }
  const drawn =
    config.discovery.open && options.openRelay
      ? drawOpen(
          open,
          config.request,
          now(),
          options.random ?? cryptoRandom,
          conversationSellers(config),
        )
      : [];
  for (const { newest, entries: listed } of drawn) {
    const trusted = await openSeller(newest, config, options, run, signal);
    signal.throwIfAborted();
    if (!trusted) continue;
    for (const entry of listed) {
      if (trusted.owner !== entry.catalog.owner) continue;
      await rememberEntry(
        entry,
        trusted,
        state,
        now(),
        Boolean(config.identity),
      );
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  return eligibleConfig(
    config,
    state,
    [...accepted, ...run.discovered.values()],
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
