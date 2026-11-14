// Per-buyer memory of work that does not change from one request to the next: each seller's verified
// catalog and presence while they stay current, and positive identity checks for a few minutes. Nothing
// here is trusted beyond what was verified when it was stored, and nothing is written to disk.
import type { KnownSeller } from '@gyblos/core/seller-selection';
import type { BuyerIdentityVerifier } from '@gyblos/node/identity-verifier';
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

// Remembers a passed identity check for `ttlMs`, so a request does not ask the registry again for every
// step (refresh, winner, execution). A refusal is never remembered: it is checked again each time. The
// cost is that a revocation reaches this buyer up to `ttlMs` late.
export function cachedIdentityCheck<
  Subject extends { nodeId: string; owner: string; manualTrust?: boolean },
  Decision extends { ok: boolean },
>(
  verify: (subject: Subject, signal?: AbortSignal) => Promise<Decision>,
  now: () => number = Date.now,
  ttlMs: number = BUYER_SELECTION.identityCacheMs,
) {
  const passed = new Map<string, { until: number; decision: Decision }>();
  return async (subject: Subject, signal?: AbortSignal) => {
    const name = `${key(subject)}/${subject.manualTrust === true}`;
    const cached = passed.get(name);
    if (cached && cached.until > now()) return cached.decision;
    passed.delete(name);
    const decision = await verify(subject, signal);
    if (decision.ok) {
      if (passed.size >= BUYER_SELECTION.maxCachedSellers) passed.clear();
      passed.set(name, { until: now() + ttlMs, decision });
    }
    return decision;
  };
}

// Work a free buyer remembers for its lifetime: verified snapshots, and passed identity checks so one
// request does not ask the registry again at every step (refresh, winner, execution).
export function rememberedWork<
  Options extends {
    snapshots?: SnapshotCache;
    identity?: BuyerIdentityVerifier;
  },
>(
  prepared: { identity?: BuyerIdentityVerifier },
  options: Options,
  now: () => number,
) {
  const identity =
    options.identity ??
    (prepared.identity && {
      verify: cachedIdentityCheck(
        prepared.identity.verify.bind(prepared.identity),
        now,
      ),
    });
  return {
    identity,
    remembered: {
      ...options,
      snapshots: options.snapshots ?? createSnapshotCache(),
      ...(identity ? { identity } : {}),
    },
  };
}
