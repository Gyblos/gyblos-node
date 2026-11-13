// Durable identity admission reserves configured IDs without counting history as live capacity.
// Called while the identity store lock is held; no floors are evicted and no limits are enlarged.
import type { IdentityState } from '@gyblos/core/identity-policy';
import { controlHex } from '@gyblos/protocol/control-validation';

import { IDENTITY_STATE } from './constants';
import { identityStateUnavailable } from './identity-state-schema';

export interface BuyerIdentityAdmission {
  configuredNodeIds: readonly string[];
}
export function identityAdmission(policy?: BuyerIdentityAdmission) {
  if (!policy) return () => true;
  if (policy.configuredNodeIds.length > IDENTITY_STATE.maxRows)
    identityStateUnavailable();
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  return (current: ReadonlyMap<string, IdentityState>, nodeId: string) => {
    if (current.has(nodeId)) return true;
    if (current.size >= IDENTITY_STATE.maxRows) return false;
    if (configured.has(nodeId)) return true;
    const missing = [...configured].filter((id) => !current.has(id)).length;
    return current.size + missing < IDENTITY_STATE.maxRows;
  };
}
