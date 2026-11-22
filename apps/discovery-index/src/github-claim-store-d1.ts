// Owns the Cloudflare D1 adapter of the seller GitHub claim storage contract (migrations/0007). Each
// write is one conditional statement on issued_at (or last_fetch_at, or checked_at), so a newer claim
// or a later check always wins a race. Rows are our own, but a corrupted row fails closed (503) instead of being trusted.
import { and, asc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';

import {
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  STORED_GITHUB_CLAIM_REASONS,
  type GithubClaimState,
  type StoredGithubClaimReason,
} from './constants';
import { createD1Orm, type DiscoveryDatabase } from './d1-client';
import {
  githubClaimTombstone,
  type GithubClaimRow,
  type GithubClaimStore,
  type RecordedCheck,
  type StoredGithubClaim,
} from './github-claim-store';
import { githubClaims } from './schema';
import {
  laterOrUnscheduled,
  laterTime,
  pendingReason,
} from './sqlite-expressions';
import type { D1Database, D1Row } from './storage-d1';
import { integer, text } from './uptime-d1';

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
  return (
    STORED_GITHUB_CLAIM_REASONS.find((reason) => reason === value) ??
    unexpected()
  );
}
function storedClaim(row: D1Row): StoredGithubClaim {
  const nodeId = text(row.nodeId);
  const issuedAt = integer(row.issuedAt);
  if (row.state === null) {
    if (
      [
        row.account,
        row.gist,
        row.reason,
        row.checkedAt,
        row.verifiedAt,
        row.nextCheckAt,
      ].some((value) => value !== null)
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
    nextCheckAt: nullableInteger(row.nextCheckAt),
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
  nextCheckAt: githubClaims.nextCheckAt,
};

// Spends the NodeId's fetch slot for this claim when the last reserved fetch is old enough; otherwise
// reads how long until it is.
async function reserveFetch(
  database: DiscoveryDatabase,
  nodeId: string,
  issuedAt: number,
  now: number,
  intervalMs: number,
) {
  const reserved = await database
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
  if (reserved.length === 1) return 0;
  const [row] = await database
    .select({
      issuedAt: githubClaims.issuedAt,
      lastFetchAt: githubClaims.lastFetchAt,
    })
    .from(githubClaims)
    .where(eq(githubClaims.nodeId, nodeId));
  const last = row ? nullableInteger(row.lastFetchAt) : null;
  if (!row || integer(row.issuedAt) !== issuedAt || last === null)
    return intervalMs;
  return Math.max(1, last + intervalMs - now);
}

// Live claims whose next check is due, earliest first.
function dueQuery(database: DiscoveryDatabase, now: number, limit: number) {
  return database
    .select(claimColumns)
    .from(githubClaims)
    .where(
      and(isNotNull(githubClaims.state), lte(githubClaims.nextCheckAt, now)),
    )
    .orderBy(asc(githubClaims.nextCheckAt), asc(githubClaims.nodeId))
    .limit(limit);
}

function unscheduleQuery(database: DiscoveryDatabase, nodeId: unknown) {
  return database
    .update(githubClaims)
    .set({ nextCheckAt: null })
    .where(eq(githubClaims.nodeId, text(nodeId)));
}

// Writes a conclusive check only while the snapshot it was computed from (its checked_at) is current.
function recordQuery(
  database: DiscoveryDatabase,
  nodeId: string,
  issuedAt: number,
  seen: number | null,
  check: RecordedCheck,
) {
  return database
    .update(githubClaims)
    .set(check)
    .where(
      and(
        eq(githubClaims.nodeId, nodeId),
        eq(githubClaims.issuedAt, issuedAt),
        isNotNull(githubClaims.state),
        seen === null
          ? isNull(githubClaims.checkedAt)
          : eq(githubClaims.checkedAt, seen),
      ),
    )
    .returning({ nodeId: githubClaims.nodeId });
}

// An inconclusive check: decided in the write, so it never rewinds a check that landed meanwhile.
function touchQuery(
  database: DiscoveryDatabase,
  nodeId: string,
  issuedAt: number,
  checkedAt: number,
  nextCheckAt: number | null,
) {
  return database
    .update(githubClaims)
    .set({
      checkedAt: laterTime(githubClaims.checkedAt, checkedAt),
      nextCheckAt: laterOrUnscheduled(githubClaims.nextCheckAt, nextCheckAt),
      reason: pendingReason(
        githubClaims.state,
        githubClaims.reason,
        GITHUB_CLAIM_STATES.PENDING,
        GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE,
      ),
    })
    .where(
      and(
        eq(githubClaims.nodeId, nodeId),
        eq(githubClaims.issuedAt, issuedAt),
        isNotNull(githubClaims.state),
      ),
    );
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
    reserveFetch: (nodeId, issuedAt, now, intervalMs) =>
      reserveFetch(database, nodeId, issuedAt, now, intervalMs),
    async record(nodeId, issuedAt, seen, check) {
      const written = await recordQuery(
        database,
        nodeId,
        issuedAt,
        seen,
        check,
      );
      return written.length === 1;
    },
    async touch(nodeId, issuedAt, checkedAt, nextCheckAt) {
      await touchQuery(database, nodeId, issuedAt, checkedAt, nextCheckAt);
    },
    // A malformed row is unscheduled (next_check_at NULL) and skipped, so it cannot stay first forever.
    async due(now, limit) {
      const claims: GithubClaimRow[] = [];
      for (const row of await dueQuery(database, now, limit)) {
        let entry: StoredGithubClaim | null = null;
        try {
          entry = storedClaim(row);
        } catch {
          await unscheduleQuery(database, row.nodeId);
        }
        if (entry?.state) claims.push(entry);
      }
      return claims;
    },
    async verified(limit) {
      const rows = await database
        .select({
          nodeId: githubClaims.nodeId,
          account: githubClaims.account,
          gist: githubClaims.gist,
        })
        .from(githubClaims)
        .where(eq(githubClaims.state, GITHUB_CLAIM_STATES.VERIFIED))
        .orderBy(asc(githubClaims.nodeId))
        .limit(limit);
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        account: text(row.account),
        gist: text(row.gist),
      }));
    },
  };
}
