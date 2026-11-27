import type { IdentityState } from '@gyblos/core/identity-policy';
import { controlHex } from '@gyblos/protocol/control-validation';

import { IDENTITY_STATE } from './constants';
import { identityStateUnavailable } from './identity-state-schema';

export interface BuyerIdentityAdmission {
  configuredNodeIds: readonly string[];
}
export function identityAdmission(policy?: BuyerIdentityAdmission) {
  if (!policy)
    return {
      admit: (
        _current: Map<string, IdentityState>,
        _nodeId: string,
        _verified: boolean,
      ) => true,
      evictable: (_nodeId: string) => false,
    };
  if (policy.configuredNodeIds.length > IDENTITY_STATE.maxRows)
    identityStateUnavailable();
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  const evictable = (nodeId: string) => !configured.has(nodeId);
  return {
    evictable,
    admit(
      current: Map<string, IdentityState>,
      nodeId: string,
      verified: boolean,
    ) {
      if (current.has(nodeId)) return true;
      const missing = [...configured].filter((id) => !current.has(id)).length;
      const limit = configured.has(nodeId)
        ? IDENTITY_STATE.maxRows
        : IDENTITY_STATE.maxRows - missing;
      const excess = current.size + 1 - limit;
      if (excess <= 0) return true;
      if (!verified) return false;
      const victims = [...current.entries()]
        .filter(([id, state]) => evictable(id) && !state.revoked)
        .slice(0, excess);
      if (victims.length < excess) return false;
      for (const [id] of victims) current.delete(id);
      return true;
    },
  };
}
