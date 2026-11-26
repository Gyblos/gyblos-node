import { controlHex } from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY } from './constants';
import { discoveryRowLive, type DiscoveryRow } from './discovery-state';

export interface DiscoveryAdmission {
  configuredNodeIds: readonly string[];
}

export function discoveryAdmission(policy?: DiscoveryAdmission) {
  if (!policy) return undefined;
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  return (rows: ReadonlyMap<string, DiscoveryRow>, nodeId: string) => {
    if (rows.has(nodeId)) return true;
    if (rows.size >= BUYER_DISCOVERY.maxStateRows) return false;
    if (configured.has(nodeId)) return true;
    const missing = [...configured].filter((id) => !rows.has(id)).length;
    return rows.size + missing < BUYER_DISCOVERY.maxStateRows;
  };
}

export function matchesDiscovery(
  rows: ReadonlyMap<string, DiscoveryRow>,
  identity: Pick<DiscoveryRow, 'nodeId' | 'owner'>,
  now: number,
) {
  const row = rows.get(identity.nodeId);
  return !!row && row.owner === identity.owner && discoveryRowLive(row, now);
}
