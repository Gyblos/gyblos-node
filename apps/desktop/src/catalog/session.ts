// Owns lazy in-memory lookup, replacement cancellation and signed expiry; never touches custody.
import type { DiscoveryFetch } from '@gyblos/discovery-http';

import {
  CATALOG_STATE,
  emptyCatalog,
  NETWORK_CATALOG,
  parseNetworkCatalog,
  validCatalogQuery,
  type NetworkCatalog,
} from './model';
import {
  browseAnnouncements,
  readAnnouncements,
  type CatalogSellerChoice,
} from './reader';

interface PendingLookup {
  query: string;
  controller: AbortController;
  result: Promise<NetworkCatalog>;
}
function expireListings(
  snapshot: NetworkCatalog,
  current: number,
): NetworkCatalog {
  if (
    snapshot.checkedAt !== null &&
    (current < snapshot.checkedAt ||
      snapshot.models.some((model) => model.expiresAt <= current))
  ) {
    const models =
      current < snapshot.checkedAt
        ? []
        : snapshot.models.filter((model) => model.expiresAt > current);
    return {
      ...snapshot,
      models,
      state: models.length ? CATALOG_STATE.READY : CATALOG_STATE.STALE,
    };
  }
  return snapshot;
}
function freshUntil(now: number, until: number) {
  return now < until && now >= until - NETWORK_CATALOG.REFRESH_MS;
}
function readCatalog(
  fetch: DiscoveryFetch,
  model: string,
  now: () => number,
  signal: AbortSignal,
  offers: Map<string, CatalogSellerChoice>,
) {
  return model
    ? readAnnouncements(fetch, model, now, signal, offers, true)
    : browseAnnouncements(fetch, now, signal, offers);
}
export function createCatalogSession(
  fetch: DiscoveryFetch,
  now: () => number,
  signal: AbortSignal,
) {
  let snapshot = emptyCatalog();
  let choices = new Map<string, CatalogSellerChoice>();
  let closed = signal.aborted;
  let sequence = 0;
  let pending: PendingLookup | null = null;
  function summary() {
    snapshot = expireListings(snapshot, now());
    return parseNetworkCatalog(snapshot);
  }
  function close() {
    closed = true;
    sequence += 1;
    pending?.controller.abort();
    snapshot = emptyCatalog(CATALOG_STATE.ERROR);
  }
  if (!closed) signal.addEventListener('abort', close, { once: true });
  let nextRefresh = 0;
  async function load(model: string) {
    if (closed) return emptyCatalog(CATALOG_STATE.ERROR);
    if (pending?.query === model) return pending.result;
    pending?.controller.abort();
    const current = ++sequence;
    const controller = new AbortController();
    if (model) snapshot = emptyCatalog(CATALOG_STATE.LOADING, model);
    const result = (async () => {
      try {
        const offers = new Map<string, CatalogSellerChoice>();
        const loaded = await readCatalog(
          fetch,
          model,
          now,
          controller.signal,
          offers,
        );
        if (!closed && sequence === current) {
          choices = offers;
          snapshot = loaded;
        }
      } catch {
        if (!closed && sequence === current)
          snapshot = emptyCatalog(CATALOG_STATE.ERROR, model);
      } finally {
        if (pending?.controller === controller) pending = null;
      }
      return summary();
    })();
    pending = { query: model, controller, result };
    return result;
  }
  return {
    summary,
    browse() {
      const current = now();
      if (pending?.query === '') return pending.result;
      if (freshUntil(current, nextRefresh)) return Promise.resolve(summary());
      nextRefresh = current + NETWORK_CATALOG.REFRESH_MS;
      return load('');
    },
    resolve(offerId: string) {
      if (
        closed ||
        !summary().models.some((model) => model.offerId === offerId)
      )
        return undefined;
      const choice = choices.get(offerId);
      return choice ? { ...choice } : undefined;
    },
    lookup(model: string) {
      return validCatalogQuery(model)
        ? load(model)
        : Promise.resolve(emptyCatalog(CATALOG_STATE.ERROR));
    },
  };
}
