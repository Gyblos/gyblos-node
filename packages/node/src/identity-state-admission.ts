import type { IdentityState } from '@gyblos/core/identity-policy';
import { controlHex } from '@gyblos/protocol/control-validation';

import { IDENTITY_STATE } from './constants';
import { identityStateUnavailable } from './identity-state-schema';

export interface BuyerIdentityAdmission {
  configuredNodeIds: readonly string[];
}
type Rows = ReadonlyMap<string, IdentityState>;

export function identityAdmission(policy?: BuyerIdentityAdmission) {
  if (!policy) return { admit: () => true, evicted: () => false };
  if (policy.configuredNodeIds.length > IDENTITY_STATE.maxRows)
    identityStateUnavailable();
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  const openLimit = (rows: Rows) =>
    IDENTITY_STATE.maxRows -
    [...configured].filter((id) => !rows.has(id)).length;
  const open = (rows: Rows) =>
    [...rows.entries()].filter(([id]) => !configured.has(id));
  const victims = (rows: Rows) => [
    ...open(rows).filter(([, state]) => !state.revoked),
    ...open(rows).filter(([, state]) => state.revoked),
  ];
  return {
    admit(
      current: Map<string, IdentityState>,
      nodeId: string,
      recordable: boolean,
    ) {
      if (current.has(nodeId)) return true;
      const limit = configured.has(nodeId)
        ? IDENTITY_STATE.maxRows
        : openLimit(current);
      const excess = current.size + 1 - limit;
      if (excess <= 0) return true;
      if (!recordable) return false;
      const chosen = victims(current).slice(0, excess);
      if (chosen.length < excess) return false;
      for (const [id] of chosen) current.delete(id);
      return true;
    },
    evicted(current: Rows, nodeId: string, previous: IdentityState) {
      if (configured.has(nodeId) || current.size < openLimit(current))
        return false;
      return (
        !previous.revoked || open(current).every(([, state]) => state.revoked)
      );
    },
  };
}
