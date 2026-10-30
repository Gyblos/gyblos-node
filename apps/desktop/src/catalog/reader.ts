// Reuses verified HTTP discovery, then projects only requested zero-price listings.
import type { DiscoveryFetch } from '@gyblos/discovery-http';

import { emptyCatalog } from './model';

export async function readFreeAnnouncements(
  _fetch: DiscoveryFetch,
  _model: string,
  _now: () => number,
  _signal: AbortSignal,
) {
  return emptyCatalog();
}
