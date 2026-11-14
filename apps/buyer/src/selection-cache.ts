// Per-buyer memory of work that does not change from one request to the next: each seller's verified
// catalog and presence while they stay current. Nothing here is trusted beyond what was verified when it
// was stored, and nothing is written to disk.
import type { KnownSeller } from '@gyblos/core/seller-selection';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import { BUYER_SELECTION } from './constants';
import { createSellerBackoff, type SellerBackoff } from './selection-backoff';
import type { StaticControlSeller } from './selection-config';

export interface SnapshotCache {
  // The seller's verified snapshot and its signed catalog, while both records stay current for at least
  // the margin.
  get(
    seller: StaticControlSeller,
    now: number,
  ): { known: KnownSeller; catalog: SignedPublicV2 } | undefined;
  set(
    seller: StaticControlSeller,
    known: KnownSeller,
    catalog: SignedPublicV2,
  ): void;
  // A seller that failed or answered with a quote that no longer matches: verify it again next time.
  drop(nodeId: string): void;
}

const key = (seller: { nodeId: string; owner: string }) =>
  `${seller.nodeId}/${seller.owner}`;

const current = (known: KnownSeller, now: number) => {
  const until = now + BUYER_SELECTION.snapshotMarginMs;
  return (
    !!known.presence &&
    known.presence.expiresAt > until &&
    known.catalog.expiresAt > until
  );
};

export function createSnapshotCache(): SnapshotCache {
  const entries = new Map<
    string,
    { known: KnownSeller; catalog: SignedPublicV2 }
  >();
  return {
    get(seller, now) {
      // A withdrawal attached by discovery changes what selection must see: no cached answer for it.
      if (seller.withdrawal) return undefined;
      const entry = entries.get(key(seller));
      if (!entry) return undefined;
      if (!current(entry.known, now)) {
        entries.delete(key(seller));
        return undefined;
      }
      return entry;
    },
    set(seller, known, catalog) {
      if (seller.withdrawal || known.withdrawal) return;
      // Full: forget what expired (sellers that left discovery) first, and only then everything.
      if (entries.size >= BUYER_SELECTION.maxCachedSellers)
        for (const [name, entry] of entries)
          if (!current(entry.known, Date.now())) entries.delete(name);
      if (entries.size >= BUYER_SELECTION.maxCachedSellers) entries.clear();
      entries.set(key(seller), { known, catalog });
    },
    drop(nodeId) {
      for (const name of entries.keys())
        if (name.startsWith(`${nodeId}/`)) entries.delete(name);
    },
  };
}

// Work a free buyer remembers for its lifetime: the verified snapshots of its sellers, and how many times
// in a row each one failed (for longer cooldowns). Identity checks are
// not remembered: a revoked seller is refused on the very next request.
export function rememberedWork<
  Options extends { snapshots?: SnapshotCache; backoff?: SellerBackoff },
>(options: Options) {
  return {
    ...options,
    snapshots: options.snapshots ?? createSnapshotCache(),
    backoff: options.backoff ?? createSellerBackoff(),
  };
}
