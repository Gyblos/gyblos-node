// Bounds live discovery candidates using existing signed-expiry metadata, retaining every replay floor.
import { createHash, randomBytes } from 'node:crypto';

import { controlHex } from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY } from './constants';
import { discoveryRowLive, type DiscoveryRow } from './discovery-state';

export interface DiscoveryAdmission {
  configuredNodeIds: readonly string[];
  now?: () => number;
  rank?: (nodeId: string, window: number) => string;
}

const order = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function secretRank() {
  const seed = randomBytes(BUYER_DISCOVERY.openSeedBytes);
  return (nodeId: string, window: number) =>
    createHash('sha256')
      .update(seed)
      .update(`${window}:${nodeId}`)
      .digest('hex');
}

export function discoveryAdmission(policy?: DiscoveryAdmission) {
  if (!policy) return undefined;
  const configured = new Set(
    policy.configuredNodeIds.map((nodeId) => controlHex(nodeId)),
  );
  const draw = policy.rank ?? secretRank();
  let drawn = { window: -1, ranks: new Map<string, string>() };
  const rank = (nodeId: string, window: number) => {
    if (drawn.window !== window) drawn = { window, ranks: new Map() };
    let value = drawn.ranks.get(nodeId);
    if (value === undefined) {
      if (drawn.ranks.size >= BUYER_DISCOVERY.maxStateRows) drawn.ranks.clear();
      drawn.ranks.set(nodeId, (value = draw(nodeId, window)));
    }
    return value;
  };
  const live = (rows: Iterable<DiscoveryRow>, now: number) =>
    [...rows].filter(
      (row) => !configured.has(row.nodeId) && discoveryRowLive(row, now),
    );
  const admitted = (rows: Iterable<DiscoveryRow>, now: number) => {
    const window = Math.floor(now / BUYER_DISCOVERY.openWindowMs);
    const ranked = live(rows, now)
      .map((row) => ({ row, rank: rank(row.nodeId, window) }))
      .sort(
        (left, right) =>
          order(left.rank, right.rank) ||
          order(left.row.nodeId, right.row.nodeId),
      );
    const owners = new Map<string, number>();
    const chosen = new Set<string>();
    for (const { row } of ranked) {
      if (chosen.size >= BUYER_DISCOVERY.openSellers) break;
      const held = owners.get(row.owner) ?? 0;
      if (held >= BUYER_DISCOVERY.openPerOwner) continue;
      owners.set(row.owner, held + 1);
      chosen.add(row.nodeId);
    }
    return chosen;
  };
  const permits = (
    rows: ReadonlyMap<string, DiscoveryRow>,
    nodeId: string,
    now: number,
  ) => configured.has(nodeId) || admitted(rows.values(), now).has(nodeId);
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
      const others = [...rows.values()].filter(
        (held) => held.nodeId !== row.nodeId,
      );
      return (
        live(others, now).length < BUYER_DISCOVERY.openSellers ||
        admitted([...others, row], now).has(row.nodeId)
      );
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
