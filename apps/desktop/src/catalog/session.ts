// Owns lazy in-memory lookup, replacement cancellation and signed expiry; never touches custody.
import type { DiscoveryFetch } from '@gyblos/discovery-http';

import {
  CATALOG_STATE,
  emptyCatalog,
  parseNetworkCatalog,
  validCatalogQuery,
  type NetworkCatalog,
} from './model';
import { readFreeAnnouncements } from './reader';

export function createCatalogSession(
  fetch: DiscoveryFetch,
  now: () => number,
  signal: AbortSignal,
) {
  let snapshot = emptyCatalog();
  let closed = signal.aborted;
  let sequence = 0;
  let pending: {
    query: string;
    controller: AbortController;
    result: Promise<NetworkCatalog>;
  } | null = null;
  function summary() {
    const current = now();
    if (
      snapshot.checkedAt !== null &&
      (current < snapshot.checkedAt ||
        snapshot.models.some((model) => model.expiresAt <= current))
    ) {
      const models =
        current < snapshot.checkedAt
          ? []
          : snapshot.models.filter((model) => model.expiresAt > current);
      snapshot = {
        ...snapshot,
        models,
        state: models.length ? CATALOG_STATE.READY : CATALOG_STATE.STALE,
      };
    }
    return parseNetworkCatalog(snapshot);
  }
  function close() {
    closed = true;
    sequence += 1;
    pending?.controller.abort();
    snapshot = emptyCatalog(CATALOG_STATE.ERROR);
  }
  if (!closed) signal.addEventListener('abort', close, { once: true });
  return {
    summary,
    async lookup(model: string): Promise<NetworkCatalog> {
      if (closed || !validCatalogQuery(model))
        return emptyCatalog(CATALOG_STATE.ERROR);
      if (pending?.query === model) return pending.result;
      pending?.controller.abort();
      const current = ++sequence;
      const controller = new AbortController();
      snapshot = emptyCatalog(CATALOG_STATE.LOADING, model);
      const result = (async () => {
        try {
          const loaded = await readFreeAnnouncements(
            fetch,
            model,
            now,
            controller.signal,
          );
          if (!closed && sequence === current) snapshot = loaded;
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
    },
  };
}
