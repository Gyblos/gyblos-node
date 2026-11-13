// Reuses verified discovery/selection for zero-price quotes without trusted-v1 authorization.
// The configured identity map remains the trust source, and replay metadata is checked before execution.
import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import type { DiscoveryFetch } from '@gyblos/discovery-http';
import type { createBuyerReceiptRuntime } from '@gyblos/node/receipts';
import { CONTROL_CODES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import {
  BUYER_SELECTION,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
} from './constants';
import { connectBuyerControl } from './control';
import { discoverBuyerSellers } from './discovery';
import { FreeBuyerError } from './free-chat';
import {
  FreeSelectionFailure,
  type FreeBuyerDependencies,
  type FreeWinner,
} from './free-execution';
import {
  recordFault,
  sellerFault,
  stickySellers,
} from './free-memory';
import { freeAdmission } from './free-parallel';
import { requireBuyerIdentity, verifyBuyerIdentity } from './identity';
import { routedRequest, type RoutedModel } from './model-routes';
import { selectBusyAwareBuyerQuote } from './selection-busy';
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
  const admission = freeAdmission(options.parallel ?? 1);
  const sticky = stickySellers(BUYER_SELECTION.stickyConversations);
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
    enter: () => admission.enter(),
    done: (winner) => admission.done(winner.nodeId),
    select: (excluded, signal, needs) =>
      admission.select(excluded, signal, (skip) =>
        selectSticky(prepared, options, sticky, skip, signal, needs),
      ),
    async execute(winner, request, signal, onDelta, beforeExecute) {
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
        {
          now,
          relayOnly: options.relayOnly,
          relayAllowed,
          onDelta,
          beforeExecute,
        },
      );
      try {
        const result = await client.execute(request, signal);
        sticky.served(winner.nodeId);
        return result;
      } catch (error) {
        // The seller broke the execution (not this buyer's deadline or the client leaving): it counts.
        if (sellerFault(error) && !signal.aborted)
          await recordFault(prepared.stats, sticky, winner.nodeId);
        throw error;
      } finally {
        await client.settled();
      }
    },
  };
}

export { sellerFault, stickySellers } from './free-memory';
export type PreparedSelection = NonNullable<
  Awaited<ReturnType<typeof prepareBuyerSelection>>
>;
export interface FreeSelectionOptions {
  receipts?: ReturnType<typeof createBuyerReceiptRuntime>;
  telemetry?: TelemetrySink;
  onSellerFailure?: SellerFailureReporter;
  onPinnedBusy?: (nodeId: string) => never;
  endpoint: Endpoint;
  buyer: string;
  relayOnly: boolean;
  now?: () => number;
  fetch?: DiscoveryFetch;
  // Free requests that may run side by side, each on its own seller; 1 when absent.
  parallel?: number;
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
// With tools, quotes ask for them; when every seller refused them, the buyer says so plainly.
async function selectFreeWinner(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
  {
    tools = false,
    model,
    previousSeller,
  }: { tools?: boolean; model?: RoutedModel; previousSeller?: string } = {},
) {
  let refusedTools = false;
  const watched: FreeSelectionOptions = {
    ...options,
    onSellerFailure: (failure) => {
      if (failure.code === CONTROL_CODES.TOOLS) refusedTools = true;
      options.onSellerFailure?.(failure);
    },
  };
  try {
    return await selectWinner(
      prepared,
      watched,
      excluded,
      signal,
      {
        ...routedRequest(prepared.config.request, model),
        maxAtomic: '0',
        priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
        ...(tools ? { tools: true as const } : {}),
      },
      previousSeller ? { previousSeller } : undefined,
    );
  } catch (error) {
    if (refusedTools && error instanceof FreeSelectionFailure && !error.retryAt)
      throw new FreeBuyerError(
        FREE_BUYER_CODES.UNAVAILABLE,
        null,
        FREE_CHAT_DETAILS.noToolSeller,
      );
    throw error;
  }
}
// One verified winner among the configured or discovered sellers not excluded, quoted for `request`.
// The policy one selection runs on: this request, the sellers not excluded, and the route's pin and
// previous seller.
function routedPolicy(
  policy: BuyerSelectionConfig,
  excluded: ReadonlySet<string>,
  request: BuyerSelectionConfig['request'],
  route?: SelectionRoute,
) {
  return {
    ...policy,
    ...(route && 'pinnedNodeId' in route
      ? { pinnedNodeId: route.pinnedNodeId }
      : {}),
    ...(route?.previousSeller ? { previousSeller: route.previousSeller } : {}),
    request,
    sellers: policy.sellers.filter((seller) => !excluded.has(seller.nodeId)),
  };
}
interface SelectionRoute {
  pinnedNodeId?: string;
  waitingFor?: string;
  previousSeller?: string;
}
export async function selectWinner(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
  request: BuyerSelectionConfig['request'],
  route?: SelectionRoute,
): Promise<FreeWinner> {
  const now = options.now ?? Date.now;
  const policy = prepared.config;
  const verifyIdentity = (seller: StaticControlSeller, querySignal?: AbortSignal) =>
    verifyBuyerIdentity(prepared.identity, seller, querySignal);
  const base = routedPolicy(policy, excluded, request, route);
  const config =
    base.discovery && prepared.discovery
      ? await discoverBuyerSellers(
          { ...base, discovery: base.discovery },
          prepared.discovery,
          {
            fetch: options.fetch ?? globalThis.fetch,
            now,
            signal,
            verifyIdentity,
          },
        )
      : base;
  const before = new Map(prepared.stats.rows);
  const stats = new Map(before);
  if (route?.waitingFor && route.waitingFor === route.pinnedNodeId) {
    const prior = stats.get(route.waitingFor);
    if (prior) stats.set(route.waitingFor, { ...prior, cooldownUntil: null });
  }
  const result = await selectBusyAwareBuyerQuote(
    config,
    {
      buyer: options.buyer,
      verifyIdentity,
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
      onPinnedBusy: options.onPinnedBusy,
    },
    signal,
  );
  signal.throwIfAborted();
  // Only the rows this selection changed: an execution or another selection may have recorded others
  // meanwhile, and a whole rewrite would erase them.
  for (const [nodeId, row] of stats)
    if (before.get(nodeId) !== row) prepared.stats.rows.set(nodeId, row);
  await prepared.stats.save();
  if (!result.ok)
    throw new FreeSelectionFailure(
      result,
      coolingUntil(config.sellers, stats, now()),
    );
  const winner = {
    nodeId: result.winner.candidate.nodeId,
    quote: result.winner.quote,
  };
  if (!(await permitsWinner(prepared, winner, now())))
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
  return winner;
}

// A winner for the request, preferring the seller that served its conversation before.
async function selectSticky(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  sticky: ReturnType<typeof stickySellers>,
  skip: ReadonlySet<string>,
  signal: AbortSignal,
  needs: Parameters<FreeBuyerDependencies['select']>[2],
) {
  const key = needs?.conversation;
  const winner = await selectFreeWinner(prepared, options, skip, signal, {
    ...needs,
    previousSeller: key ? sticky.get(key) : undefined,
  });
  if (key) sticky.chose(key, winner.nodeId);
  return winner;
}

// The earliest moment a seller in cooldown can be tried again; undefined when none is cooling down.
function coolingUntil(
  sellers: readonly { nodeId: string }[],
  stats: ReadonlyMap<string, { cooldownUntil: number | null }>,
  now: number,
) {
  const ends = sellers
    .map((seller) => stats.get(seller.nodeId)?.cooldownUntil ?? null)
    .filter((end): end is number => end !== null && end > now);
  return ends.length > 0 ? Math.min(...ends) : undefined;
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
