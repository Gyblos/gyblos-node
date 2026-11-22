// Owns the seller GitHub claim storage contract and its in-process adapter for tests and local runs; the
// D1 adapter is github-claim-store-d1.ts (table in migrations/0007). Rows hold the newest node-signed
// claim per NodeId and the index's last gist check; nothing here sees an IP or request header.
import type { GithubClaimReason, GithubClaimState } from './constants';

// The outcome of one gist check as stored.
export interface GithubCheck {
  state: GithubClaimState;
  reason: GithubClaimReason | null;
  checkedAt: number | null;
  verifiedAt: number | null;
}

export interface GithubClaimRow extends GithubCheck {
  nodeId: string;
  account: string;
  gist: string;
  issuedAt: number;
}

export interface GithubClaimSummary {
  nodeId: string;
  account: string;
  state: GithubClaimState;
}

export interface GithubClaimStore {
  get(nodeId: string): Promise<GithubClaimRow | null>;
  // Atomic: written only when no claim is stored or the stored one has an older issuedAt.
  put(row: GithubClaimRow): Promise<boolean>;
  // Atomic: deletes the NodeId's claim only when its issuedAt is older than `issuedAt`.
  remove(nodeId: string, issuedAt: number): Promise<void>;
  // Records a check of the claim issued at `issuedAt`; a newer claim stored meanwhile is left alone.
  record(nodeId: string, issuedAt: number, check: GithubCheck): Promise<void>;
  // Claims never checked or last checked before `before`, least recently checked first.
  due(before: number, limit: number): Promise<GithubClaimRow[]>;
  // Every claim's account and state by NodeId, at most `limit`, for GET /v1/network.
  list(limit: number): Promise<GithubClaimSummary[]>;
}

const byNodeId = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

// Same semantics as the D1 adapter, in process memory.
export function createMemoryGithubClaimStore(): GithubClaimStore {
  const rows = new Map<string, GithubClaimRow>();
  return {
    async get(nodeId) {
      const row = rows.get(nodeId);
      return row ? { ...row } : null;
    },
    async put(row) {
      const current = rows.get(row.nodeId);
      if (current && current.issuedAt >= row.issuedAt) return false;
      rows.set(row.nodeId, { ...row });
      return true;
    },
    async remove(nodeId, issuedAt) {
      const current = rows.get(nodeId);
      if (current && current.issuedAt < issuedAt) rows.delete(nodeId);
    },
    async record(nodeId, issuedAt, check) {
      const current = rows.get(nodeId);
      if (current?.issuedAt === issuedAt)
        rows.set(nodeId, { ...current, ...check });
    },
    async due(before, limit) {
      return [...rows.values()]
        .filter((row) => row.checkedAt === null || row.checkedAt < before)
        .sort(
          (left, right) =>
            (left.checkedAt ?? -Infinity) - (right.checkedAt ?? -Infinity) ||
            byNodeId(left.nodeId, right.nodeId),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async list(limit) {
      return [...rows.values()]
        .sort((left, right) => byNodeId(left.nodeId, right.nodeId))
        .slice(0, limit)
        .map(({ nodeId, account, state }) => ({ nodeId, account, state }));
    },
  };
}
