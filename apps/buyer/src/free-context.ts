// The context a free route's sellers all accept, read from their verified catalogs and presence (cached
// snapshots reused) without asking any seller for a quote. /v1/models reports it so agents size prompts.
import { smallestContextTokens } from '@gyblos/core/seller-selection';

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

export async function freeRouteContext(
  prepared: PreparedSelection,
  options: FreeSelectionOptions,
  model: RoutedModel,
  signal: AbortSignal,
) {
  const now = options.now ?? Date.now;
  const verifyIdentity = (seller: StaticControlSeller, query?: AbortSignal) =>
    verifyBuyerIdentity(prepared.identity, seller, query);
  // The same zero-price request a free selection quotes, for this route's model.
  const request = {
    ...routedRequest(prepared.config.request, model),
    maxAtomic: '0',
    priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  };
  const config = await withDiscovered(
    prepared,
    routedPolicy(prepared.config, new Set(), request),
    { fetch: options.fetch ?? globalThis.fetch, now, signal, verifyIdentity },
    // Like a free selection: with open discovery, every seller the index lists counts, not only the
    // configured ones (a desktop buyer configures none).
    new Set(),
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
  return smallestContextTokens({
    request,
    sellers,
    stats: new Map(),
    now: now(),
  });
}
