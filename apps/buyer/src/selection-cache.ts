// Per-buyer memory of work that does not change from one request to the next: each seller's verified
// catalog and presence while they stay current. Nothing here is trusted beyond what was verified when it
// was stored, and nothing is written to disk.
import type { KnownSeller } from '@gyblos/core/seller-selection';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import { BUYER_SELECTION } from './constants';
import type { StaticControlSeller } from './selection-config';

export interface SnapshotCache {
  // The seller's verified snapshot, while both records stay current for at least the margin.
  get(seller: StaticControlSeller, now: number): KnownSeller | undefined;
  set(
    seller: StaticControlSeller,
    known: KnownSeller,
    catalog: SignedPublicV2,
  ): void;
  // The signed catalog behind a cached snapshot, for a new connection to quote against.
  signedCatalog(seller: StaticControlSeller): SignedPublicV2 | undefined;
  // A seller that failed or answered with a quote that no longer matches: verify it again next time.
  drop(nodeId: string): void;
}

const key = (seller: { nodeId: string; owner: string }) =>
  `${seller.nodeId}/${seller.owner}`;

export function createSnapshotCache(): SnapshotCache {
  const entries = new Map<
    string,
    { known: KnownSeller; catalog: SignedPublicV2 }
  >();
  return {
    get(seller, now) {
      // A withdrawal attached by discovery changes what selection must see: no cached answer for it.
      if (seller.withdrawal) return undefined;
      const known = entries.get(key(seller))?.known;
      if (!known) return undefined;
      const until = now + BUYER_SELECTION.snapshotMarginMs;
      if (
        !known.presence ||
        known.presence.expiresAt <= until ||
        known.catalog.expiresAt <= until
      ) {
        entries.delete(key(seller));
        return undefined;
      }
      return known;
    },
    set(seller, known, catalog) {
      if (seller.withdrawal || known.withdrawal) return;
      if (entries.size >= BUYER_SELECTION.maxCachedSellers) entries.clear();
      entries.set(key(seller), { known, catalog });
    },
    signedCatalog(seller) {
      return entries.get(key(seller))?.catalog;
    },
    drop(nodeId) {
      for (const name of entries.keys())
        if (name.startsWith(`${nodeId}/`)) entries.delete(name);
    },
  };
}

// Work a free buyer remembers for its lifetime: the verified snapshots of its sellers. Identity checks are
// not remembered: a revoked seller is refused on the very next request.
export function rememberedWork<Options extends { snapshots?: SnapshotCache }>(
  options: Options,
) {
  return {
    ...options,
    snapshots: options.snapshots ?? createSnapshotCache(),
  };
}
