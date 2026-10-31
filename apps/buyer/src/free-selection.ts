// Reuses verified discovery/selection for zero-price quotes without trusted-v1 authorization.
// The configured identity map remains the trust source, and replay metadata is checked before execution.
import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import type { DiscoveryFetch } from '@gyblos/discovery-http';
import type { createBuyerReceiptRuntime } from '@gyblos/node/receipts';
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { FREE_BUYER_CODES } from './constants';
import { connectBuyerControl } from './control';
import { discoverBuyerSellers } from './discovery';
import { FreeBuyerError } from './free-chat';
import {
  FreeSelectionFailure,
  type FreeBuyerDependencies,
  type FreeWinner,
} from './free-execution';
import { requireBuyerIdentity, verifyBuyerIdentity } from './identity';
import { selectVerifiedBuyerQuote } from './selection';
import type {
  BuyerSelectionConfig,
  StaticControlSeller,
} from './selection-config';
import type { prepareBuyerSelection } from './selection-runtime';
import type { SellerFailureReporter } from './seller-failures';

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
    permitsWinner(prepared, winner, now());

  return {
    telemetry: options.telemetry
      ? {
          sink: options.telemetry,
          buyerNodeId: options.endpoint.id().toString(),
          selection: policy.request.selection,
          now,
        }
      : undefined,
    receiptNow: now,
    receipt: options.receipts
      ? async (winner, evidence, signal) => {
          const seller = sellers.get(winner.nodeId);
          if (seller)
            options.receipts!.exchange(address(seller), evidence, signal);
        }
      : undefined,
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
      if (
        !seller ||
        !(await permits(winner)) ||
        !(await verifyBuyerIdentity(prepared.identity, seller, signal))
      )
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

export type PreparedSelection = NonNullable<
  Awaited<ReturnType<typeof prepareBuyerSelection>>
>;
export interface FreeSelectionOptions {
  receipts?: ReturnType<typeof createBuyerReceiptRuntime>;
  telemetry?: TelemetrySink;
  onSellerFailure?: SellerFailureReporter;
  endpoint: Endpoint;
  buyer: string;
  relayOnly: boolean;
  now?: () => number;
  fetch?: DiscoveryFetch;
}
export function sellerAddress(seller: StaticControlSeller, relayOnly: boolean) {
  if (seller.relayUrl) assertConfiguredRelay(seller.relayUrl);
  return new EndpointAddr(
    EndpointId.fromString(seller.nodeId),
    seller.relayUrl ?? undefined,
    relayOnly ? [] : seller.directAddresses,
  );
}
export function relayAllowed(origin: string) {
  try {
    assertConfiguredRelay(origin);
    return true;
  } catch {
    return false;
  }
}
export async function permitsWinner(
  prepared: PreparedSelection,
  winner: Pick<FreeWinner, 'nodeId' | 'quote'>,
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
function selectFreeWinner(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
) {
  return selectWinner(prepared, options, excluded, signal, {
    ...prepared.config.request,
    maxAtomic: '0',
    priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  });
}
// One verified winner among the configured or discovered sellers not excluded, quoted for `request`.
export async function selectWinner(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
  request: BuyerSelectionConfig['request'],
): Promise<FreeWinner> {
  const now = options.now ?? Date.now;
  const policy = prepared.config;
  const base = {
    ...policy,
    request,
    sellers: policy.sellers.filter((seller) => !excluded.has(seller.nodeId)),
  };
  const config =
    base.discovery && prepared.discovery
      ? await discoverBuyerSellers(
          { ...base, discovery: base.discovery },
          prepared.discovery,
          {
            fetch: options.fetch ?? globalThis.fetch,
            now,
            signal,
            verifyIdentity: (seller, querySignal) =>
              verifyBuyerIdentity(prepared.identity, seller, querySignal),
          },
        )
      : base;
  const stats = new Map(prepared.stats.rows);
  const result = await selectVerifiedBuyerQuote(
    config,
    {
      buyer: options.buyer,
      verifyIdentity: (seller, querySignal) =>
        verifyBuyerIdentity(prepared.identity, seller, querySignal),
      now,
      stats,
      observeVerified: prepared.discovery
        ? (seller) =>
            prepared.discovery!.observe(seller, {
              allowOwnerChange: Boolean(prepared.identity),
            })
        : undefined,
      connect: (seller) => connectFreeControl(seller, options, now),
      onSellerFailure: options.onSellerFailure,
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
  if (!(await permitsWinner(prepared, winner, now())))
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  return winner;
}

export async function connectFreeControl(
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
