// Bounds live discovery candidates using existing signed-expiry metadata, retaining every replay floor.
import { controlHex } from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY } from './constants';
import { discoveryRowLive, type DiscoveryRow } from './discovery-state';

export interface DiscoveryAdmission {
  configuredNodeIds: readonly string[];
  now?: () => number;
}

export function discoveryAdmission(policy?: DiscoveryAdmission) {
  if (!policy) return undefined;
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  const live = (rows: ReadonlyMap<string, DiscoveryRow>, now: number) =>
    [...rows.values()]
      .filter(
        (row) => !configured.has(row.nodeId) && discoveryRowLive(row, now),
      )
      .sort((left, right) =>
        left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
      );
  const permits = (
    rows: ReadonlyMap<string, DiscoveryRow>,
    nodeId: string,
    now: number,
  ) =>
    configured.has(nodeId) ||
    live(rows, now)
      .slice(0, BUYER_DISCOVERY.openSellers)
      .some((row) => row.nodeId === nodeId);
  return {
    now: policy.now ?? Date.now,
    permits,
    accepts(
      rows: ReadonlyMap<string, DiscoveryRow>,
      row: DiscoveryRow,
      now: number,
    ) {
      const prior = rows.get(row.nodeId);
      if (!prior) {
        if (rows.size >= BUYER_DISCOVERY.maxStateRows) return false;
        const missing = [...configured].filter(
          (nodeId) => !rows.has(nodeId),
        ).length;
        if (
          !configured.has(row.nodeId) &&
          rows.size + missing >= BUYER_DISCOVERY.maxStateRows
        )
          return false;
      }
      // Negative observations still persist withdrawal/conflict floors and immediately release eligibility.
      if (configured.has(row.nodeId) || !discoveryRowLive(row, now))
        return true;
      if (prior && discoveryRowLive(prior, now))
        return permits(rows, row.nodeId, now);
      return live(rows, now).length < BUYER_DISCOVERY.openSellers;
    },
  };
}

// Eligibility and final digest admission share the same live working set.
export function matchesDiscovery(
  rows: ReadonlyMap<string, DiscoveryRow>,
  identity: Pick<DiscoveryRow, 'nodeId' | 'owner'>,
  now: number,
  admission: ReturnType<typeof discoveryAdmission>,
) {
  const row = rows.get(identity.nodeId);
  return (
    !!row &&
    row.owner === identity.owner &&
    discoveryRowLive(row, now) &&
    (admission?.permits(rows, identity.nodeId, now) ?? true)
  );
}
