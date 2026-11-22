// Owns the Cloudflare D1 adapter of the seller GitHub claim storage contract (migrations/0007). Each
// write is one conditional statement on issued_at (or last_fetch_at), so a newer claim always wins a
// race. Rows are our own, but a corrupted row fails closed (503) instead of being trusted.
import { and, asc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';

import {
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  type GithubClaimState,
  type StoredGithubClaimReason,
} from './constants';
import { createD1Orm, type DiscoveryDatabase } from './d1-client';
import {
  githubClaimTombstone,
  type GithubClaimRow,
  type GithubClaimStore,
  type StoredGithubClaim,
} from './github-claim-store';
import { githubClaims } from './schema';
import type { D1Database, D1Row } from './storage-d1';
import { integer, text } from './uptime-d1';

const STORED_REASONS: readonly StoredGithubClaimReason[] = [
  GITHUB_CLAIM_REASONS.GIST_NOT_FOUND,
  GITHUB_CLAIM_REASONS.NODE_ID_MISSING,
];

function unexpected(): never {
  throw new TypeError('Unexpected GitHub claim row.');
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function stateOf(value: unknown): GithubClaimState {
  return (
    Object.values(GITHUB_CLAIM_STATES).find((state) => state === value) ??
    unexpected()
  );
}
function reasonOf(value: unknown): StoredGithubClaimReason | null {
  if (value === null) return null;
  return STORED_REASONS.find((reason) => reason === value) ?? unexpected();
}
function storedClaim(row: D1Row): StoredGithubClaim {
  const nodeId = text(row.nodeId);
  const issuedAt = integer(row.issuedAt);
  if (row.state === null) {
    if (
      [row.account, row.gist, row.reason, row.checkedAt, row.verifiedAt].some(
        (value) => value !== null,
      )
    )
      return unexpected();
    return githubClaimTombstone(nodeId, issuedAt);
  }
  return {
    nodeId,
    account: text(row.account),
    gist: text(row.gist),
    issuedAt,
    state: stateOf(row.state),
    reason: reasonOf(row.reason),
    checkedAt: nullableInteger(row.checkedAt),
    verifiedAt: nullableInteger(row.verifiedAt),
  };
}
const claimColumns = {
  nodeId: githubClaims.nodeId,
  account: githubClaims.account,
  gist: githubClaims.gist,
  issuedAt: githubClaims.issuedAt,
  state: githubClaims.state,
  reason: githubClaims.reason,
  checkedAt: githubClaims.checkedAt,
  verifiedAt: githubClaims.verifiedAt,
};

// Spends the NodeId's fetch slot for this claim when the last reserved fetch is old enough.
function reserveFetchQuery(
  database: DiscoveryDatabase,
  nodeId: string,
  issuedAt: number,
  now: number,
  intervalMs: number,
) {
  return database
    .update(githubClaims)
    .set({ lastFetchAt: now })
    .where(
      and(
        eq(githubClaims.nodeId, nodeId),
        eq(githubClaims.issuedAt, issuedAt),
        or(
          isNull(githubClaims.lastFetchAt),
          lte(githubClaims.lastFetchAt, now - intervalMs),
        ),
      ),
    )
    .returning({ nodeId: githubClaims.nodeId });
}

// Live claims never checked or last checked before `before`, least recently checked first.
function dueQuery(database: DiscoveryDatabase, before: number, limit: number) {
  return database
    .select(claimColumns)
    .from(githubClaims)
    .where(
      and(
        isNotNull(githubClaims.state),
        or(isNull(githubClaims.checkedAt), lt(githubClaims.checkedAt, before)),
      ),
    )
    .orderBy(asc(githubClaims.checkedAt), asc(githubClaims.nodeId))
    .limit(limit);
}

export function createD1GithubClaimStore(client: D1Database): GithubClaimStore {
  const database = createD1Orm(client);
  return {
    async get(nodeId) {
      const [row] = await database
        .select(claimColumns)
        .from(githubClaims)
        .where(eq(githubClaims.nodeId, nodeId));
      return row ? storedClaim(row) : null;
    },
    // last_fetch_at is not in the entry, so an update keeps the NodeId's fetch reservation.
    async put(entry) {
      const { nodeId: _nodeId, ...fields } = entry;
      const written = await database
        .insert(githubClaims)
        .values(entry)
        .onConflictDoUpdate({
          target: githubClaims.nodeId,
          set: fields,
          setWhere: lt(githubClaims.issuedAt, entry.issuedAt),
        })
        .returning({ nodeId: githubClaims.nodeId });
      return written.length === 1;
    },
    async reserveFetch(nodeId, issuedAt, now, intervalMs) {
      const reserved = await reserveFetchQuery(
        database,
        nodeId,
        issuedAt,
        now,
        intervalMs,
      );
      return reserved.length === 1;
    },
    async record(nodeId, issuedAt, check) {
      await database
        .update(githubClaims)
        .set(check)
        .where(
          and(
            eq(githubClaims.nodeId, nodeId),
            eq(githubClaims.issuedAt, issuedAt),
            isNotNull(githubClaims.state),
          ),
        );
    },
    async due(before, limit) {
      return (await dueQuery(database, before, limit))
        .map(storedClaim)
        .filter((entry): entry is GithubClaimRow => entry.state !== null);
    },
    async verified(limit) {
      const rows = await database
        .select({
          nodeId: githubClaims.nodeId,
          account: githubClaims.account,
        })
        .from(githubClaims)
        .where(eq(githubClaims.state, GITHUB_CLAIM_STATES.VERIFIED))
        .orderBy(asc(githubClaims.nodeId))
        .limit(limit);
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        account: text(row.account),
      }));
    },
  };
}
