// The context a route's sellers accept, read from their verified catalogs and presence (cached snapshots
// reused) without asking any seller for a quote. /v1/models reports it so agents size prompts.
import {
  announcedContext,
  listedContexts,
  type KnownSeller,
  type SellerRequest,
} from '@gyblos/core/seller-selection';

import { FREE_BUYER } from './constants';
import { routedPolicy, withDiscovered } from './free-route';
import {
  connectFreeControl,
  type FreeSelectionOptions,
  type PreparedSelection,
} from './free-selection';
import { verifyBuyerIdentity } from './identity';
import { routedRequest, type RoutedModel } from './model-routes';
import { verifiedSnapshots } from './selection';
import type { StaticControlSeller } from './selection-config';

// What reports a route's context; undefined when no seller's is known.
export type RouteContext<Route extends RoutedModel = RoutedModel> = (
  model: Route,
  signal: AbortSignal,
) => Promise<number | undefined>;

const free = (request: SellerRequest): SellerRequest => ({
  ...request,
  maxAtomic: '0',
  priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
});

// The sellers a request may reach, as selection reaches them: configured sellers at the buyer's own
// prices, and, with open discovery, sellers found only in the index for free.
export function routeContextTokens(input: {
  request: SellerRequest;
  sellers: readonly KnownSeller[];
  configured: ReadonlySet<string>;
  open: boolean;
  now: number;
}) {
  const isConfigured = (seller: KnownSeller) =>
    input.configured.has(seller.catalog.nodeId);
  return announcedContext([
    ...listedContexts({
      request: input.request,
      sellers: input.sellers.filter(isConfigured),
      now: input.now,
    }),
    ...(input.open
      ? listedContexts({
          request: free(input.request),
          sellers: input.sellers.filter((seller) => !isConfigured(seller)),
          now: input.now,
        })
      : []),
  ]);
}

export async function routeContext(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  model: RoutedModel,
  signal: AbortSignal,
) {
  const now = options.now ?? Date.now;
  const verifyIdentity = (seller: StaticControlSeller, query?: AbortSignal) =>
    verifyBuyerIdentity(prepared.identity, seller, query);
  const request = routedRequest(prepared.config.request, model);
  const open = prepared.config.discovery?.open === true;
  const config = await withDiscovered(
    prepared,
    routedPolicy(prepared.config, new Set(), request),
    { fetch: options.fetch ?? globalThis.fetch, now, signal, verifyIdentity },
    // With open discovery, every seller the index lists is read too (a desktop buyer configures none).
    open ? new Set() : undefined,
  );
  const sellers = await verifiedSnapshots(
    config,
    {
      buyer: options.buyer,
      verifyIdentity,
      now,
      // No cooldowns: a seller resting after a failure still bounds what a prompt may need.
      stats: new Map(),
      connect: (seller) => connectFreeControl(seller, options, now),
      ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    },
    signal,
  );
  return routeContextTokens({
    request,
    sellers,
    configured: new Set(prepared.config.sellers.map((seller) => seller.nodeId)),
    open,
    now: now(),
  });
}

// One read per route and period, shared by the requests that arrive meanwhile: listing models does not
// reach every seller each time. The read has its own deadline, so a caller that leaves does not cut it
// short for the others. A read that finds no context (sellers unreachable, discovery not ready yet) is
// shared only while it runs: the next request reads again.
export function cachedRouteContext(
  read: RouteContext,
  options: { ttlMs: number; timeoutMs: number; now: () => number },
): RouteContext {
  const entries = new Map<
    string,
    { at: number; context: Promise<number | undefined> }
  >();
  return (model, signal) => {
    const key = JSON.stringify([model.selection, model.maxTokens]);
    const at = options.now();
    let entry = entries.get(key);
    if (!entry || at - entry.at >= options.ttlMs) {
      const context = read(model, AbortSignal.timeout(options.timeoutMs))
        .catch(() => undefined)
        .then((found) => {
          if (found === undefined && entries.get(key) === current)
            entries.delete(key);
          return found;
        });
      const current = { at, context };
      entry = current;
      entries.set(key, entry);
    }
    if (signal.aborted) return Promise.resolve(undefined);
    return Promise.race([
      entry.context,
      new Promise<undefined>((resolve) =>
        signal.addEventListener('abort', () => resolve(undefined), {
          once: true,
        }),
      ),
    ]);
  };
}

// The buyer's /v1/models context reader: one cached read per route.
export function routeContextReader(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  now: () => number,
) {
  return cachedRouteContext(
    (model, signal) => routeContext(prepared, options, model, signal),
    {
      ttlMs: FREE_BUYER.modelContextCacheMs,
      timeoutMs: FREE_BUYER.modelContextMs,
      now,
    },
  );
}
