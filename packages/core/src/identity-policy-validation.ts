// Parses the identity-policy boundary without trusting typed callers, getters or unknown fields.
// Validation creates detached state; it neither verifies signatures nor performs registry reads.
import {
  controlAddress,
  controlFail,
  controlHex,
  controlNetwork,
  controlObject,
} from '@gyblos/protocol/control-validation';

import {
  IDENTITY_LOOKUP_FAILURES,
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_POLICY_LIMITS,
} from './constants.js';
import type {
  IdentityBinding,
  IdentityLookup,
  IdentityRegistryScope,
  IdentityState,
} from './identity-policy-types.js';

export function identityScope(value: unknown): IdentityRegistryScope {
  const row = controlObject(value, ['network', 'program', 'collection']);
  return {
    network: controlNetwork(row.network),
    program: controlAddress(row.program),
    collection: controlAddress(row.collection),
  };
}
function identityBinding(value: unknown): IdentityBinding {
  const row = controlObject(value, ['nodeId', 'owner', 'asset', 'sequence']);
  if (
    typeof row.sequence !== 'bigint' ||
    row.sequence < 0n ||
    row.sequence > IDENTITY_POLICY_LIMITS.maxSequence
  )
    return controlFail();
  return {
    nodeId: controlHex(row.nodeId),
    owner: controlAddress(row.owner),
    asset: controlAddress(row.asset),
    sequence: row.sequence,
  };
}
export function previousIdentityState(
  value: unknown,
): IdentityState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'previous');
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) return controlFail();
  const previous: unknown = descriptor.value;
  if (previous === undefined) return undefined;
  const row = controlObject(previous, ['scope', 'binding', 'revoked']);
  if (typeof row.revoked !== 'boolean') return controlFail();
  return {
    scope: identityScope(row.scope),
    binding: identityBinding(row.binding),
    revoked: row.revoked,
  };
}
export function identityPolicyEnvelope(value: unknown) {
  const optional = ['manual', 'previous', 'lookup'].filter(
    (key) =>
      value !== null && typeof value === 'object' && Object.hasOwn(value, key),
  );
  const row = controlObject(value, ['nodeId', 'owner', 'scope', ...optional]);
  return {
    nodeId: controlHex(row.nodeId),
    owner: controlAddress(row.owner),
    scope: identityScope(row.scope),
    manual: row.manual,
    lookup: row.lookup,
  };
}
export function manualIdentity(value: unknown) {
  const row = controlObject(value, ['nodeId', 'owner']);
  return { nodeId: controlHex(row.nodeId), owner: controlAddress(row.owner) };
}
export function identityLookup(value: unknown): IdentityLookup {
  const property =
    value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'kind')
      : undefined;
  const kind: unknown =
    property && 'value' in property ? property.value : undefined;
  const base = controlObject(value, [
    'kind',
    'nodeId',
    'scope',
    ...(kind === IDENTITY_LOOKUP_KINDS.BOUND
      ? ['binding']
      : kind === IDENTITY_LOOKUP_KINDS.UNAVAILABLE
        ? ['reason']
        : []),
  ]);
  const scope = identityScope(base.scope);
  if (base.kind === IDENTITY_LOOKUP_KINDS.BOUND)
    return {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: controlHex(base.nodeId),
      scope,
      binding: identityBinding(base.binding),
    };
  if (base.kind === IDENTITY_LOOKUP_KINDS.MISSING)
    return {
      kind: IDENTITY_LOOKUP_KINDS.MISSING,
      nodeId: controlHex(base.nodeId),
      scope,
    };
  if (base.kind === IDENTITY_LOOKUP_KINDS.UNAVAILABLE) {
    for (const reason of Object.values(IDENTITY_LOOKUP_FAILURES))
      if (reason === base.reason) {
        const nodeId =
          base.nodeId === null && reason === IDENTITY_LOOKUP_FAILURES.INVALID
            ? null
            : controlHex(base.nodeId);
        return {
          kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
          nodeId,
          scope,
          reason,
        };
      }
  }
  return controlFail();
}
export function sameIdentityScope(
  first: IdentityRegistryScope,
  second: IdentityRegistryScope,
) {
  return (
    first.network === second.network &&
    first.program === second.program &&
    first.collection === second.collection
  );
}
