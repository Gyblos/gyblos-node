// Shared per-request routing over trusted selection/execution ports; no payment SDK or persistence.
import { setTimeout as delay } from 'node:timers/promises';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { BUYER_ROUTING_DEFAULTS } from '@gyblos/config/buyer-routing';
import {
  BuyerRoutingError,
  fallbackPriceCeilings,
  type BuyerRoutingPolicy,
} from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import {
  OFFER_PRICING_KINDS,
  type OfferPricingKind,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import { bounded } from './buyer-operation';
import { PaidBuyerError } from './buyer-paid-error';
import {
  buyerQuoteKind,
  executeBuyerQuote,
  type BuyerQuoteDependencies,
  type BuyerQuoteWinner,
} from './buyer-quote-execution';
import { createBuyerQueue, type BuyerWaitScope } from './buyer-routing-queue';
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
  // Host may ignore only a known busy cooldown while refreshing this exact queued seller.
  waitingFor?: string;
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
  'enter' | 'unresolved' | 'select' | 'free' | 'paid'
> & {
  // Trusted execution port ends queue time immediately before its first possible prompt write.
  free(
    winner: BuyerQuoteWinner,
    signal: AbortSignal,
    sending?: () => void,
  ): Promise<T | undefined>;
  paid(
    winner: BuyerQuoteWinner,
    signal: AbortSignal,
    sending?: () => void,
  ): Promise<T | undefined>;
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
  queue: ReturnType<typeof createBuyerQueue>;
}
interface Request<T> extends BuyerRouteSelection {
  ports: BuyerRoutePorts<T>;
  excluded: Set<string>;
  owner: symbol;
  wait?: BuyerWaitScope;
  kind?: OfferPricingKind;
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
async function unresolved(state: State) {
  try {
    const blocked = await state.options.unresolved();
    if (blocked)
      state.queue.cancel(new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED));
    return blocked;
  } catch (error) {
    state.queue.cancel(new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED));
    throw error;
  }
}
async function waitForSeller<T>(
  state: State,
  request: Request<T>,
  nodeId: string,
  signal: AbortSignal,
  remote = false,
) {
  request.wait ??= state.queue.scope(signal, state.options.policy.queueWaitMs);
  request.pinnedNodeId = nodeId;
  request.waitingFor = nodeId;
  if (remote) state.queue.release(nodeId, request.owner);
  await state.queue.acquire(nodeId, request.owner, request.wait.signal);
  if (remote) {
    try {
      await delay(BUYER_ROUTING_DEFAULTS.queuePollMs, undefined, {
        signal: request.wait.signal,
      });
    } catch {
      request.wait.signal.throwIfAborted();
    }
  }
  if (await bounded(unresolved(state), request.wait.signal))
    throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
  request.wait.signal.throwIfAborted();
}
function occupied<T>(state: State, request: Request<T>, nodeId: string) {
  const owner = state.owners.get(nodeId);
  return owner !== undefined && owner !== request.owner;
}
async function select<T>(
  state: State,
  request: Request<T>,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<BuyerQuoteWinner> {
  while (true) {
    const current = request.wait?.signal ?? signal;
    current.throwIfAborted();
    const pinned = request.pinnedNodeId;
    if (pinned && occupied(state, request, pinned)) {
      if (state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT)
        await waitForSeller(state, request, pinned, signal);
      else
        fallback(
          state,
          request,
          pinned,
          await state.options.reference(pinned, current),
        );
    }
    const checking = request.wait?.signal ?? signal;
    const running = state.selection.then(() => {
      checking.throwIfAborted();
      return request.ports.select(
        new Set([...excluded, ...request.excluded]),
        checking,
        {
          priceCeilings: request.priceCeilings,
          pinnedNodeId: request.pinnedNodeId,
          waitingFor: request.waitingFor,
        },
      );
    });
    state.selection = running.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await bounded(running, checking);
    } catch (error) {
      if (!(error instanceof UnsentSellerBusyError)) throw error;
      checking.throwIfAborted();
      if (state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT)
        await waitForSeller(state, request, error.nodeId, signal, true);
      else
        fallback(
          state,
          request,
          error.nodeId,
          await state.options.reference(error.nodeId, signal),
        );
    }
  }
}
async function refreshWaiting<T>(
  state: State,
  request: Request<T>,
  winner: BuyerQuoteWinner,
  signal: AbortSignal,
  remote = false,
): Promise<T | undefined> {
  request.priceCeilings = fallbackPriceCeilings(
    state.options.policy,
    winner.quote.offer.prices,
    request.priceCeilings,
  )!;
  await waitForSeller(state, request, winner.nodeId, signal, remote);
  const fresh = await select(state, request, new Set(), signal);
  if (fresh.nodeId !== winner.nodeId)
    throw new BuyerRoutingError(BUYER_ROUTING_CODES.INVALID);
  const kind = buyerQuoteKind(fresh.quote);
  return attempt(
    state,
    request,
    fresh,
    signal,
    kind === OFFER_PRICING_KINDS.FREE ? request.ports.free : request.ports.paid,
  );
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
  if (occupied(state, request, winner.nodeId)) {
    if (state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT)
      return refreshWaiting(state, request, winner, signal);
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  }
  if (await bounded(unresolved(state), request.wait?.signal ?? signal))
    throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
  (request.wait?.signal ?? signal).throwIfAborted();
  if (occupied(state, request, winner.nodeId)) {
    if (state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT)
      return refreshWaiting(state, request, winner, signal);
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  }
  request.wait?.signal.throwIfAborted();
  request.kind = buyerQuoteKind(winner.quote);
  state.owners.set(winner.nodeId, request.owner);
  try {
    const current = request.wait?.signal ?? signal;
    const result = await run(winner, current, () => {
      current.throwIfAborted();
      request.wait?.dispose();
      request.wait = undefined;
      request.waitingFor = undefined;
    });
    if (
      result === undefined &&
      state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT
    )
      throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
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
    ) {
      const current = request.wait?.signal ?? signal;
      await bounded(unresolved(state), current);
      current.throwIfAborted();
      throw error;
    }
    signal.throwIfAborted();
    if (state.options.policy.onBusy === BUYER_BUSY_POLICIES.WAIT)
      return await refreshWaiting(state, request, winner, signal, true);
    fallback(state, request, winner.nodeId, prices);
    return undefined;
  } finally {
    state.queue.release(winner.nodeId, request.owner);
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
  const operation = executeBuyerQuote(
    {
      enter: () => {
        signal.throwIfAborted();
        if (state.requests.size >= TRANSPORT_LIMITS.maxConcurrent)
          return busy();
        state.requests.add(request.owner);
        return () => state.requests.delete(request.owner);
      },
      unresolved: () => unresolved(state),
      select: (excluded, current) => select(state, request, excluded, current),
      free: (winner, current) =>
        attempt(state, request, winner, current, ports.free),
      paid: (winner, current) =>
        attempt(state, request, winner, current, ports.paid),
    },
    signal,
  );
  const pending = operation
    .then((result) => ({ ...result, kind: request.kind ?? result.kind }))
    .finally(() => {
      request.wait?.dispose();
      for (const [nodeId, owner] of [...state.owners])
        if (owner === request.owner) state.queue.release(nodeId, owner);
    });
  state.pending.add(pending);
  void pending.then(
    () => state.pending.delete(pending),
    () => state.pending.delete(pending),
  );
  return pending;
}
export function createBuyerRouter(options: BuyerRouteOptions) {
  const owners = new Map<string, symbol>();
  const state: State = {
    options,
    owners,
    queue: createBuyerQueue(owners),
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
      state.queue.cancel(state.lifetime.signal.reason);
      while (state.pending.size) await Promise.allSettled([...state.pending]);
      await state.selection;
      state.queue.dispose();
    },
  };
}
