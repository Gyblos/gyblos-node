// Validates durable identity metadata; disk content is untrusted and never upgrades identity itself.
// Sequence strings stay exact u64 values; malformed or duplicate rows never reset trust history.
import {
  evaluateIdentityPolicy,
  type IdentityPolicyDecision,
  type IdentityRegistryScope,
  type IdentityState,
} from '@gyblos/core/identity-policy';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlAddress,
  controlArray,
  controlAtomic,
  controlHex,
  controlNetwork,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { IDENTITY_STATE, NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';

export function identityStateUnavailable(): never {
  throw new NodeError(NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE);
}
export function checkedIdentityScope(value: unknown): IdentityRegistryScope {
  const input = controlObject(value, ['network', 'program', 'collection']);
  return {
    network: controlNetwork(input.network),
    program: controlAddress(input.program),
    collection: controlAddress(input.collection),
  };
}
export function sameIdentityState(first: IdentityState, second: IdentityState) {
  return (
    first.binding.nodeId === second.binding.nodeId &&
    first.binding.owner === second.binding.owner &&
    first.binding.asset === second.binding.asset &&
    first.binding.sequence === second.binding.sequence &&
    first.revoked === second.revoked
  );
}
function parseState(value: unknown, scope: IdentityRegistryScope) {
  const row = controlObject(value, ['binding', 'revoked']);
  const binding = controlObject(row.binding, [
    'nodeId',
    'owner',
    'asset',
    'sequence',
  ]);
  const nodeId = controlHex(binding.nodeId);
  const owner = controlAddress(binding.owner);
  const previous = {
    scope,
    binding: {
      nodeId,
      owner,
      asset: controlAddress(binding.asset),
      sequence: BigInt(controlAtomic(binding.sequence)),
    },
    revoked: row.revoked,
  };
  const parsed = evaluateIdentityPolicy({
    nodeId,
    owner,
    scope,
    previous,
    manual: { nodeId, owner },
  });
  if (!parsed.ok || !parsed.state) return identityStateUnavailable();
  return parsed.state;
}
export function parseIdentityStates(
  bytes: string,
  scope: IdentityRegistryScope,
) {
  const value: unknown = JSON.parse(bytes);
  if (canonicalJson(value) !== bytes) identityStateUnavailable();
  const input = controlObject(value, ['schemaVersion', 'scope', 'rows']);
  if (
    input.schemaVersion !== IDENTITY_STATE.schemaVersion ||
    canonicalJson(checkedIdentityScope(input.scope)) !== canonicalJson(scope)
  )
    identityStateUnavailable();
  const rows = controlArray(input.rows, IDENTITY_STATE.maxRows).map((value) =>
    parseState(value, scope),
  );
  const result = new Map(rows.map((row) => [row.binding.nodeId, row]));
  if (result.size !== rows.length) identityStateUnavailable();
  return result;
}
export function encodeIdentityStates(
  rows: ReadonlyMap<string, IdentityState>,
  scope: IdentityRegistryScope,
) {
  if (rows.size > IDENTITY_STATE.maxRows) identityStateUnavailable();
  const bytes = canonicalJson({
    schemaVersion: IDENTITY_STATE.schemaVersion,
    scope,
    rows: [...rows.values()].map((state) => ({
      binding: {
        ...state.binding,
        sequence: state.binding.sequence.toString(),
      },
      revoked: state.revoked,
    })),
  });
  if (Buffer.byteLength(bytes) > IDENTITY_STATE.maxBytes)
    identityStateUnavailable();
  return bytes;
}
export function assertIdentityMonotonic(
  held: ReadonlyMap<string, IdentityState>,
  current: ReadonlyMap<string, IdentityState>,
) {
  for (const [nodeId, previous] of held) {
    const next = current.get(nodeId);
    if (
      !next ||
      next.binding.sequence < previous.binding.sequence ||
      (next.binding.sequence === previous.binding.sequence &&
        (!sameIdentityState({ ...next, revoked: previous.revoked }, previous) ||
          (previous.revoked && !next.revoked)))
    )
      identityStateUnavailable();
  }
}

// Append only verified policy state; unknown identities never evict existing replay history.
export function recordIdentityDecision(
  current: Map<string, IdentityState>,
  decision: IdentityPolicyDecision,
) {
  if (!decision.state) return;
  const nodeId = decision.state.binding.nodeId;
  if (!current.has(nodeId) && current.size >= IDENTITY_STATE.maxRows)
    identityStateUnavailable();
  current.set(nodeId, decision.state);
}
