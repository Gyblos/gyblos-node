// Keeps only independently admitted bindings within both wall and monotonic freshness bounds.
// A forward wall-clock jump covers suspension; elapsed time prevents rollback extending trust.
import {
  IDENTITY_LOOKUP_KINDS,
  type IdentityLookup,
} from '@gyblos/core/identity-policy';

import { BUYER_IDENTITY, IDENTITY_STATE } from './constants';

export interface IdentityReuseOptions {
  now?: () => number;
  monotonicNow?: () => number;
  freshLookupMs?: number;
}
type Binding = Extract<
  IdentityLookup,
  { kind: typeof IDENTITY_LOOKUP_KINDS.BOUND }
>;
export function identityReuse(options: IdentityReuseOptions) {
  const duration = options.freshLookupMs ?? BUYER_IDENTITY.freshLookupMs;
  if (
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    duration > BUYER_IDENTITY.maxFreshLookupMs
  )
    throw new RangeError('Invalid identity reuse duration');
  const wallNow = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const time = () => ({ wall: wallNow(), elapsed: monotonicNow() });
  type Stamp = ReturnType<typeof time>;
  const recent = new Map<string, { lookup: Binding; at: Stamp }>();
  const fresh = (at: Stamp) => {
    const current = time();
    return [current.wall - at.wall, current.elapsed - at.elapsed].every(
      (age) => Number.isFinite(age) && age >= 0 && age < duration,
    );
  };
  return {
    time,
    fresh,
    get(nodeId: string) {
      const kept = recent.get(nodeId);
      if (kept && fresh(kept.at)) return kept;
      recent.delete(nodeId);
      return undefined;
    },
    keep(nodeId: string, lookup: Binding, at: Stamp) {
      if (!fresh(at)) return;
      recent.set(nodeId, { lookup, at });
      if (recent.size > IDENTITY_STATE.maxRows) recent.clear();
    },
    drop(nodeId: string) {
      recent.delete(nodeId);
    },
  };
}
