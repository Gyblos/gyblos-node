// Owns the seller GitHub claim storage contract and its in-process adapter for tests and local runs; the
// D1 adapter is github-claim-store-d1.ts (table in migrations/0007). Rows hold the newest node-signed
// claim per NodeId (or a cancel's tombstone) and the index's last gist check; nothing here sees an IP
// or request header.
import {
  GITHUB_CLAIM_STATES,
  type GithubClaimState,
  type StoredGithubClaimReason,
} from './constants';

// The outcome of one gist check as stored, and when the scheduled run should check it next.
export interface GithubCheck {
  state: GithubClaimState;
  reason: StoredGithubClaimReason | null;
  checkedAt: number | null;
  verifiedAt: number | null;
  // Never served. Null: not scheduled (an abandoned pending claim; a new POST checks it).
  nextCheckAt: number | null;
}
// A finished check: `checkedAt` is the time the check started.
export type RecordedCheck = GithubCheck & { checkedAt: number };

export interface GithubClaimRow extends GithubCheck {
  nodeId: string;
  account: string;
  gist: string;
  issuedAt: number;
}

// A cancel: only the NodeId's newest issuedAt is kept, so an older signed claim cannot be replayed.
export interface GithubClaimTombstone {
  nodeId: string;
  issuedAt: number;
  account: null;
  gist: null;
  state: null;
  reason: null;
  checkedAt: null;
  verifiedAt: null;
  nextCheckAt: null;
}
export type StoredGithubClaim = GithubClaimRow | GithubClaimTombstone;

export function githubClaimTombstone(
  nodeId: string,
  issuedAt: number,
): GithubClaimTombstone {
  return {
    nodeId,
    issuedAt,
    account: null,
    gist: null,
    state: null,
    reason: null,
    checkedAt: null,
    verifiedAt: null,
    nextCheckAt: null,
  };
}

export interface GithubClaimStore {
  get(nodeId: string): Promise<StoredGithubClaim | null>;
  // Atomic: written only when nothing is stored for the NodeId or the stored issuedAt is older.
  put(entry: StoredGithubClaim): Promise<boolean>;
  // Atomic: reserves a gist fetch for the claim issued at `issuedAt` when the NodeId's last reserved
  // fetch (kept across claims) is at least `intervalMs` old. Returns 0 when reserved, otherwise the
  // milliseconds until a fetch can be reserved (`intervalMs` when another claim is stored).
  reserveFetch(
    nodeId: string,
    issuedAt: number,
    now: number,
    intervalMs: number,
  ): Promise<number>;
  // Records a check of the claim issued at `issuedAt`. A newer claim stored meanwhile, or a check that
  // started later and already landed, is left alone.
  record(nodeId: string, issuedAt: number, check: RecordedCheck): Promise<void>;
  // Claims whose next check is due at `now`, earliest first.
  due(now: number, limit: number): Promise<GithubClaimRow[]>;
  // Verified claims by NodeId, at most `limit`, for GET /v1/network.
  verified(
    limit: number,
  ): Promise<{ nodeId: string; account: string; gist: string }[]>;
}

const byNodeId = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const isClaim = (entry: StoredGithubClaim): entry is GithubClaimRow =>
  entry.state !== null;

// Same semantics as the D1 adapter, in process memory.
export function createMemoryGithubClaimStore(): GithubClaimStore {
  const entries = new Map<string, StoredGithubClaim>();
  const fetchedAt = new Map<string, number>();
  const claims = () => [...entries.values()].filter(isClaim);
  return {
    async get(nodeId) {
      const entry = entries.get(nodeId);
      return entry ? { ...entry } : null;
    },
    async put(entry) {
      const current = entries.get(entry.nodeId);
      if (current && current.issuedAt >= entry.issuedAt) return false;
      entries.set(entry.nodeId, { ...entry });
      return true;
    },
    async reserveFetch(nodeId, issuedAt, now, intervalMs) {
      const last = fetchedAt.get(nodeId);
      if (entries.get(nodeId)?.issuedAt !== issuedAt) return intervalMs;
      if (last !== undefined && last > now - intervalMs)
        return last + intervalMs - now;
      fetchedAt.set(nodeId, now);
      return 0;
    },
    async record(nodeId, issuedAt, check) {
      const current = entries.get(nodeId);
      if (
        current &&
        isClaim(current) &&
        current.issuedAt === issuedAt &&
        (current.checkedAt === null || current.checkedAt <= check.checkedAt)
      )
        entries.set(nodeId, { ...current, ...check });
    },
    async due(now, limit) {
      return claims()
        .filter((row) => row.nextCheckAt !== null && row.nextCheckAt <= now)
        .sort(
          (left, right) =>
            (left.nextCheckAt ?? 0) - (right.nextCheckAt ?? 0) ||
            byNodeId(left.nodeId, right.nodeId),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async verified(limit) {
      return claims()
        .filter((row) => row.state === GITHUB_CLAIM_STATES.VERIFIED)
        .sort((left, right) => byNodeId(left.nodeId, right.nodeId))
        .slice(0, limit)
        .map(({ nodeId, account, gist }) => ({ nodeId, account, gist }));
    },
  };
}
