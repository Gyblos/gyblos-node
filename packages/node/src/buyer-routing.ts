// Shared per-request routing over trusted selection/execution ports; no payment SDK or persistence.
import { TRANSPORT_LIMITS } from '@gyblos/config';
import {
  BuyerRoutingError,
  fallbackPriceCeilings,
  type BuyerRoutingPolicy,
} from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import { PaidBuyerError } from './buyer-paid-error';
import {
  executeBuyerQuote,
  type BuyerQuoteDependencies,
  type BuyerQuoteWinner,
} from './buyer-quote-execution';
import { PAID_BUYER_CODES } from './constants';

export class UnsentSellerBusyError extends Error {
  readonly code = BUYER_ROUTING_CODES.BUSY;
  readonly neverSent = true;
  constructor(readonly nodeId: string) {
    super(BUYER_ROUTING_CODES.BUSY);
    this.name = 'UnsentSellerBusyError';
  }
}
export interface BuyerRouteSelection {
  pinnedNodeId?: string;
  priceCeilings: TokenPricesV2;
}
export interface BuyerRouteOptions {
  policy: BuyerRoutingPolicy;
  pinnedNodeId?: string;
  priceCeilings: TokenPricesV2;
  unresolved(): Promise<boolean>;
  // Trusted host supplies only a fresh signed reference with independently verified identity/replay state.
  reference(
    nodeId: string,
    signal: AbortSignal,
  ): Promise<TokenPricesV2 | undefined>;
}
export type BuyerRoutePorts<T> = Omit<
  BuyerQuoteDependencies<T>,
  'enter' | 'unresolved' | 'select'
> & {
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
    policy: BuyerRouteSelection,
  ): ReturnType<BuyerQuoteDependencies<T>['select']>;
};
interface State {
  options: BuyerRouteOptions;
  owners: Map<string, symbol>;
  requests: Set<symbol>;
  pending: Set<Promise<unknown>>;
  lifetime: AbortController;
  selection: Promise<unknown>;
}
interface Request<T> extends BuyerRouteSelection {
  ports: BuyerRoutePorts<T>;
  excluded: Set<string>;
  owner: symbol;
}
function busy(): never {
  throw new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY);
}
function fallback<T>(
  state: State,
  request: Request<T>,
  nodeId: string,
  reference: TokenPricesV2 | undefined,
) {
  const policy = state.options.policy;
  if (
    policy.onBusy !== BUYER_BUSY_POLICIES.REROUTE ||
    (state.options.pinnedNodeId === nodeId && !policy.allowPinnedFallback)
  )
    return busy();
  const limits = fallbackPriceCeilings(
    policy,
    reference,
    request.priceCeilings,
  );
  if (!limits || request.excluded.has(nodeId)) return busy();
  request.priceCeilings = limits;
  request.excluded.add(nodeId);
  request.pinnedNodeId = undefined;
}
async function select<T>(
  state: State,
  request: Request<T>,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<BuyerQuoteWinner> {
  const previous = state.selection;
  const running = previous.then(async () => {
    while (true) {
      signal.throwIfAborted();
      const pinned = request.pinnedNodeId;
      if (pinned && state.owners.has(pinned))
        fallback(
          state,
          request,
          pinned,
          await state.options.reference(pinned, signal),
        );
      try {
        return await request.ports.select(
          new Set([...excluded, ...request.excluded]),
          signal,
          {
            priceCeilings: request.priceCeilings,
            pinnedNodeId: request.pinnedNodeId,
          },
        );
      } catch (error) {
        if (!(error instanceof UnsentSellerBusyError)) throw error;
        signal.throwIfAborted();
        fallback(
          state,
          request,
          error.nodeId,
          await state.options.reference(error.nodeId, signal),
        );
      }
    }
  });
  state.selection = running.then(
    () => undefined,
    () => undefined,
  );
  return running;
}
async function attempt<T>(
  state: State,
  request: Request<T>,
  winner: BuyerQuoteWinner,
  signal: AbortSignal,
  run: BuyerRoutePorts<T>['paid'],
) {
  const prices = winner.quote.offer.prices;
  if (
    BigInt(prices.inputAtomicPerMtok) >
      BigInt(request.priceCeilings.inputAtomicPerMtok) ||
    BigInt(prices.outputAtomicPerMtok) >
      BigInt(request.priceCeilings.outputAtomicPerMtok)
  )
    return busy();
  if (state.owners.has(winner.nodeId)) {
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  }
  if (await state.options.unresolved())
    throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
  signal.throwIfAborted();
  if (state.owners.has(winner.nodeId)) {
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  }
  state.owners.set(winner.nodeId, request.owner);
  try {
    const result = await run(winner, signal);
    if (result === undefined)
      request.priceCeilings = fallbackPriceCeilings(
        state.options.policy,
        prices,
        request.priceCeilings,
      )!;
    return result;
  } catch (error) {
    if (
      !(error instanceof UnsentSellerBusyError) ||
      error.nodeId !== winner.nodeId
    )
      throw error;
    signal.throwIfAborted();
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  } finally {
    if (state.owners.get(winner.nodeId) === request.owner)
      state.owners.delete(winner.nodeId);
  }
}
function run<T>(
  state: State,
  ports: BuyerRoutePorts<T>,
  external: AbortSignal,
) {
  const request: Request<T> = {
    ports,
    excluded: new Set(),
    owner: Symbol(),
    pinnedNodeId: state.options.pinnedNodeId,
    priceCeilings: { ...state.options.priceCeilings },
  };
  const signal = AbortSignal.any([external, state.lifetime.signal]);
  const pending = executeBuyerQuote(
    {
      enter: () => {
        signal.throwIfAborted();
        if (state.requests.size >= TRANSPORT_LIMITS.maxConcurrent)
          return busy();
        state.requests.add(request.owner);
        return () => state.requests.delete(request.owner);
      },
      unresolved: state.options.unresolved,
      select: (excluded, current) => select(state, request, excluded, current),
      free: (winner, current) =>
        attempt(state, request, winner, current, ports.free),
      paid: (winner, current) =>
        attempt(state, request, winner, current, ports.paid),
    },
    signal,
  );
  state.pending.add(pending);
  void pending.then(
    () => state.pending.delete(pending),
    () => state.pending.delete(pending),
  );
  return pending;
}
export function createBuyerRouter(options: BuyerRouteOptions) {
  const state: State = {
    options,
    owners: new Map(),
    requests: new Set(),
    pending: new Set(),
    lifetime: new AbortController(),
    selection: Promise.resolve(),
  };
  return {
    activeRequests: () => state.requests.size,
    execute: <T>(ports: BuyerRoutePorts<T>, signal: AbortSignal) =>
      run(state, ports, signal),
    async close() {
      state.lifetime.abort();
      while (state.pending.size) await Promise.allSettled([...state.pending]);
      await state.selection;
    },
  };
}
