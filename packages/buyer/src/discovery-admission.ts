import { controlHex } from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY } from './constants';
import { discoveryRowLive, type DiscoveryRow } from './discovery-state';

export interface DiscoveryAdmission {
  configuredNodeIds: readonly string[];
  now?: () => number;
}

const lastExpiry = (row: DiscoveryRow) =>
  Math.max(row.catalogExpiresAt, row.presenceExpiresAt);

export function discoveryAdmission(policy?: DiscoveryAdmission) {
  if (!policy) return undefined;
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  const now = policy.now ?? Date.now;
  const evictable = (row: DiscoveryRow) =>
    !configured.has(row.nodeId) &&
    now() >= lastExpiry(row) + BUYER_DISCOVERY.evictAfterMs;
  return {
    evictable,
    admit(rows: Map<string, DiscoveryRow>, nodeId: string) {
      if (rows.has(nodeId)) return true;
      const missing = [...configured].filter((id) => !rows.has(id)).length;
      const limit = configured.has(nodeId)
        ? BUYER_DISCOVERY.maxStateRows
        : BUYER_DISCOVERY.maxStateRows - missing;
      const excess = rows.size + 1 - limit;
      if (excess <= 0) return true;
      const victims = [...rows.values()]
        .filter(evictable)
        .sort((left, right) => lastExpiry(left) - lastExpiry(right))
        .slice(0, excess);
      if (victims.length < excess) return false;
      for (const victim of victims) rows.delete(victim.nodeId);
      return true;
    },
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
