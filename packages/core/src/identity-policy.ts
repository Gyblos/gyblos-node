// Decides explicit manual or registry identity trust, preserving binding floors and revocation tombstones.
// No lookup, cache, persistence, clocks or SDKs; the caller must retain returned state even on denial.
import {
  IDENTITY_LOOKUP_FAILURES,
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_POLICY_CODES,
  IDENTITY_TRUST_SOURCES,
  type IdentityPolicyCode,
} from './constants.js';
import type {
  IdentityBinding,
  IdentityLookup,
  IdentityPolicyDecision,
  IdentityState,
} from './identity-policy-types.js';
import {
  identityLookup,
  identityPolicyEnvelope,
  manualIdentity,
  previousIdentityState,
  sameIdentityScope,
} from './identity-policy-validation.js';

export {
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_LOOKUP_FAILURES,
  IDENTITY_TRUST_SOURCES,
  IDENTITY_POLICY_CODES,
  type IdentityLookupFailure,
  type IdentityPolicyCode,
  type IdentityTrustSource,
} from './constants.js';
export type {
  IdentityRegistryScope,
  IdentityBinding,
  IdentityLookup,
  IdentityState,
  IdentityPolicyInput,
  IdentityPolicyDecision,
} from './identity-policy-types.js';

function denied(
  code: IdentityPolicyCode,
  state?: IdentityState,
): IdentityPolicyDecision {
  return { ok: false, code, ...(state ? { state } : {}) };
}
const FAILURE_CODES = {
  [IDENTITY_LOOKUP_FAILURES.INVALID]: IDENTITY_POLICY_CODES.INVALID,
  [IDENTITY_LOOKUP_FAILURES.UNAVAILABLE]: IDENTITY_POLICY_CODES.UNAVAILABLE,
  [IDENTITY_LOOKUP_FAILURES.AMBIGUOUS]: IDENTITY_POLICY_CODES.AMBIGUOUS,
  [IDENTITY_LOOKUP_FAILURES.LIMIT]: IDENTITY_POLICY_CODES.LIMIT,
  [IDENTITY_LOOKUP_FAILURES.TIMEOUT]: IDENTITY_POLICY_CODES.TIMEOUT,
  [IDENTITY_LOOKUP_FAILURES.CANCELLED]: IDENTITY_POLICY_CODES.CANCELLED,
  [IDENTITY_LOOKUP_FAILURES.NETWORK]: IDENTITY_POLICY_CODES.NETWORK,
};
function unavailable(
  lookup: Extract<
    IdentityLookup,
    { kind: typeof IDENTITY_LOOKUP_KINDS.UNAVAILABLE }
  >,
  previous?: IdentityState,
) {
  return denied(FAILURE_CODES[lookup.reason], previous);
}
function bound(
  lookup: Extract<IdentityLookup, { kind: typeof IDENTITY_LOOKUP_KINDS.BOUND }>,
  owner: string,
  previous?: IdentityState,
): IdentityPolicyDecision {
  const current = lookup.binding;
  const prior = previous?.binding;
  if (previous?.revoked && current.sequence <= previous.binding.sequence)
    return denied(IDENTITY_POLICY_CODES.REVOKED, previous);
  if (prior && current.sequence < prior.sequence)
    return denied(IDENTITY_POLICY_CODES.STALE, previous);
  if (
    prior &&
    current.sequence === prior.sequence &&
    !sameBinding(current, prior)
  )
    return denied(IDENTITY_POLICY_CODES.CONFLICT, previous);
  const state = { scope: lookup.scope, binding: current, revoked: false };
  if (current.owner !== owner)
    return denied(
      prior && prior.owner !== current.owner
        ? IDENTITY_POLICY_CODES.OWNER_CHANGED
        : IDENTITY_POLICY_CODES.OWNER_MISMATCH,
      state,
    );
  return { ok: true, source: IDENTITY_TRUST_SOURCES.REGISTRY, state };
}
function sameBinding(first: IdentityBinding, second: IdentityBinding) {
  return (
    first.nodeId === second.nodeId &&
    first.owner === second.owner &&
    first.asset === second.asset
  );
}
export function evaluateIdentityPolicy(value: unknown): IdentityPolicyDecision {
  let previous: IdentityState | undefined;
  try {
    previous = previousIdentityState(value);
    const input = identityPolicyEnvelope(value);
    if (
      previous &&
      (!sameIdentityScope(previous.scope, input.scope) ||
        previous.binding.nodeId !== input.nodeId)
    )
      return denied(IDENTITY_POLICY_CODES.SCOPE, previous);
    if (input.manual !== undefined) {
      const manual = manualIdentity(input.manual);
      if (manual.nodeId !== input.nodeId || manual.owner !== input.owner)
        return denied(IDENTITY_POLICY_CODES.OWNER_MISMATCH, previous);
      return {
        ok: true,
        source: IDENTITY_TRUST_SOURCES.MANUAL,
        ...(previous ? { state: previous } : {}),
      };
    }
    if (input.lookup === undefined)
      return denied(IDENTITY_POLICY_CODES.UNAVAILABLE, previous);
    const lookup = identityLookup(input.lookup);
    if (!sameIdentityScope(lookup.scope, input.scope))
      return denied(IDENTITY_POLICY_CODES.SCOPE, previous);
    if (lookup.kind === IDENTITY_LOOKUP_KINDS.UNAVAILABLE)
      return unavailable(lookup, previous);
    if (lookup.kind === IDENTITY_LOOKUP_KINDS.MISSING)
      return previous
        ? denied(IDENTITY_POLICY_CODES.REVOKED, { ...previous, revoked: true })
        : denied(IDENTITY_POLICY_CODES.NOT_FOUND);
    if (lookup.binding.nodeId !== input.nodeId)
      return denied(IDENTITY_POLICY_CODES.SCOPE, previous);
    return bound(lookup, input.owner, previous);
  } catch {
    return denied(IDENTITY_POLICY_CODES.INVALID, previous);
  }
}
