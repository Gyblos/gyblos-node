// Identity trust shapes are SDK independent; callers own observations and durable high-water state.
// Registry lookup is evidence supplied by an authenticated adapter, not a seller or discovery hint.
import type {
  IDENTITY_LOOKUP_KINDS,
  IdentityLookupFailure,
  IdentityPolicyCode,
  IdentityTrustSource,
} from './constants';

export interface IdentityRegistryScope {
  network: string;
  program: string;
  collection: string;
}
export interface IdentityBinding {
  nodeId: string;
  owner: string;
  asset: string;
  sequence: bigint;
}
export type IdentityLookup =
  | {
      kind: typeof IDENTITY_LOOKUP_KINDS.BOUND;
      nodeId: string;
      scope: IdentityRegistryScope;
      binding: IdentityBinding;
    }
  | {
      kind: typeof IDENTITY_LOOKUP_KINDS.MISSING;
      nodeId: string;
      scope: IdentityRegistryScope;
    }
  | {
      kind: typeof IDENTITY_LOOKUP_KINDS.UNAVAILABLE;
      nodeId: string | null;
      scope: IdentityRegistryScope;
      reason: IdentityLookupFailure;
    };
export interface IdentityState {
  scope: IdentityRegistryScope;
  binding: IdentityBinding;
  revoked: boolean;
}
export interface IdentityPolicyInput {
  nodeId: string;
  owner: string;
  scope: IdentityRegistryScope;
  manual?: { nodeId: string; owner: string };
  previous?: IdentityState;
  lookup?: IdentityLookup;
}
export type IdentityPolicyDecision =
  | { ok: true; source: IdentityTrustSource; state?: IdentityState }
  | { ok: false; code: IdentityPolicyCode; state?: IdentityState };
