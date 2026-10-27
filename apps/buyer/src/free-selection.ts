// Reuses verified discovery/selection for zero-price quotes without trusted-v1 authorization.
// The configured identity map remains the trust source, and replay metadata is checked before execution.
import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import type { DiscoveryFetch } from '@gyblos/discovery-http';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { FREE_BUYER_CODES } from './constants.js';
import { connectBuyerControl } from './control.js';
import { discoverBuyerSellers } from './discovery.js';
import { verifyBuyerIdentity, requireBuyerIdentity } from './identity.js';
import { FreeBuyerError } from './free-chat.js';
import {
  FreeSelectionFailure,
  type FreeBuyerDependencies,
  type FreeWinner,
} from './free-execution.js';
import type { StaticControlSeller } from './selection-config.js';
import type { prepareBuyerSelection } from './selection-runtime.js';
import { selectVerifiedBuyerQuote } from './selection.js';

export function freeBuyerDependencies(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
): FreeBuyerDependencies {
  requireBuyerIdentity(prepared.config, prepared.identity);
  let active = false;
  const now = options.now ?? Date.now;
  const policy = prepared.config;
  if (
    policy.request.reasoning !== REASONING_LEVELS.OFF ||
    policy.request.lowestReasoning !== null
  )
    throw new FreeBuyerError(FREE_BUYER_CODES.CONFIG);
  const sellers = new Map(
    policy.sellers.map((seller) => [seller.nodeId, seller]),
  );
  const address = (seller: StaticControlSeller) =>
    sellerAddress(seller, options.relayOnly);
  const permits = (winner: FreeWinner) =>
    permitsFreeWinner(prepared, winner, now());

  return {
    enter() {
      if (active) throw new FreeBuyerError(FREE_BUYER_CODES.BUSY);
      active = true;
      return () => {
        active = false;
      };
    },
    select: (excluded, signal) =>
      selectFreeWinner(prepared, options, excluded, signal),
    async execute(winner, request, signal, onDelta) {
      const seller = sellers.get(winner.nodeId);
      if (!seller || !(await permits(winner)) || !(await verifyBuyerIdentity(prepared.identity, seller, signal)))
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      signal.throwIfAborted();
      const client = createFreeExecutionClient(
        options.endpoint,
        address(seller),
        seller,
        { now, relayOnly: options.relayOnly, relayAllowed, onDelta },
      );
      try {
        return await client.execute(request, signal);
      } finally {
        await client.settled();
      }
    },
  };
}

type PreparedSelection = NonNullable<
  Awaited<ReturnType<typeof prepareBuyerSelection>>
>;
interface FreeSelectionOptions {
  endpoint: Endpoint;
  buyer: string;
  relayOnly: boolean;
  now?: () => number;
  fetch?: DiscoveryFetch;
}
function sellerAddress(seller: StaticControlSeller, relayOnly: boolean) {
  if (seller.relayUrl) assertConfiguredRelay(seller.relayUrl);
  return new EndpointAddr(
    EndpointId.fromString(seller.nodeId),
    seller.relayUrl ?? undefined,
    relayOnly ? [] : seller.directAddresses,
  );
}
function relayAllowed(origin: string) {
  try {
    assertConfiguredRelay(origin);
    return true;
  } catch {
    return false;
  }
}
async function permitsFreeWinner(
  prepared: PreparedSelection,
  winner: FreeWinner,
  now: number,
) {
  return (
    !prepared.discovery ||
    prepared.discovery.permits(
      winner.quote.offer.owner,
      winner.nodeId,
      winner.quote.offer.catalogDigest,
      now,
    )
  );
}
async function selectFreeWinner(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const now = options.now ?? Date.now;
  const policy = prepared.config;
  const base = {
    ...policy,
    request: {
      ...policy.request,
      maxAtomic: '0',
      priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    },
    sellers: policy.sellers.filter((seller) => !excluded.has(seller.nodeId)),
  };
  const config =
    base.discovery && prepared.discovery
      ? await discoverBuyerSellers(
          { ...base, discovery: base.discovery },
          prepared.discovery,
          { fetch: options.fetch ?? globalThis.fetch, now, signal, verifyIdentity: (seller, querySignal) => verifyBuyerIdentity(prepared.identity, seller, querySignal) },
        )
      : base;
  const stats = new Map(prepared.stats.rows);
  const result = await selectVerifiedBuyerQuote(
    config,
    {
      buyer: options.buyer,
      verifyIdentity: (seller, querySignal) => verifyBuyerIdentity(prepared.identity, seller, querySignal),
      now,
      stats,
      observeVerified: prepared.discovery
        ? (seller) => prepared.discovery!.observe(seller, { allowOwnerChange: Boolean(prepared.identity) })
        : undefined,
      connect: (seller) => connectFreeControl(seller, options, now),
    },
    signal,
  );
  signal.throwIfAborted();
  prepared.stats.rows.clear();
  for (const [nodeId, row] of stats) prepared.stats.rows.set(nodeId, row);
  await prepared.stats.save();
  if (!result.ok) throw new FreeSelectionFailure(result);
  const winner = {
    nodeId: result.winner.candidate.nodeId,
    quote: result.winner.quote,
  };
  if (!(await permitsFreeWinner(prepared, winner, now())))
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  return winner;
}

async function connectFreeControl(
  seller: StaticControlSeller,
  options: FreeSelectionOptions,
  now: () => number,
) {
  const client = await connectBuyerControl(
    options.endpoint,
    sellerAddress(seller, options.relayOnly),
    { owner: seller.owner, nodeId: seller.nodeId, now, relayAllowed },
    options.relayOnly,
  );
  return {
    getCatalog: (...args: Parameters<typeof client.getCatalog>) =>
      client.getCatalog(...args),
    getPresence: (...args: Parameters<typeof client.getPresence>) =>
      client.getPresence(...args),
    requestOffer: (...args: Parameters<typeof client.requestOffer>) =>
      client.requestOffer(...args),
    async close() {
      try {
        await client.close();
      } finally {
        await client.settled();
      }
    },
  };
}
