// Owns the Cloudflare D1 adapter of the seller GitHub claim storage contract (migrations/0007). Each
// write is one conditional statement on issued_at, so a newer claim always wins a race. Rows are our
// own, but a corrupted row fails closed (503) instead of being trusted.
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';

import {
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  type GithubClaimReason,
  type GithubClaimState,
} from './constants';
import { createD1Orm } from './d1-client';
import type { GithubClaimRow, GithubClaimStore } from './github-claim-store';
import { githubClaims } from './schema';
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
function reasonOf(value: unknown): GithubClaimReason | null {
  if (value === null) return null;
  return (
    Object.values(GITHUB_CLAIM_REASONS).find((reason) => reason === value) ??
    unexpected()
  );
}
function claimRow(row: D1Row): GithubClaimRow {
  return {
    nodeId: text(row.nodeId),
    account: text(row.account),
    gist: text(row.gist),
    issuedAt: integer(row.issuedAt),
    state: stateOf(row.state),
    reason: reasonOf(row.reason),
    checkedAt: nullableInteger(row.checkedAt),
    verifiedAt: nullableInteger(row.verifiedAt),
  };
}

export function createD1GithubClaimStore(client: D1Database): GithubClaimStore {
  const database = createD1Orm(client);
  return {
    async get(nodeId) {
      const [row] = await database
        .select()
        .from(githubClaims)
        .where(eq(githubClaims.nodeId, nodeId));
      return row ? claimRow(row) : null;
    },
    async put(row) {
      const { nodeId: _nodeId, ...fields } = row;
      const written = await database
        .insert(githubClaims)
        .values(row)
        .onConflictDoUpdate({
          target: githubClaims.nodeId,
          set: fields,
          setWhere: lt(githubClaims.issuedAt, row.issuedAt),
        })
        .returning({ nodeId: githubClaims.nodeId });
      return written.length === 1;
    },
    async remove(nodeId, issuedAt) {
      await database
        .delete(githubClaims)
        .where(
          and(
            eq(githubClaims.nodeId, nodeId),
            lt(githubClaims.issuedAt, issuedAt),
          ),
        );
    },
    async record(nodeId, issuedAt, check) {
      await database
        .update(githubClaims)
        .set(check)
        .where(
          and(
            eq(githubClaims.nodeId, nodeId),
            eq(githubClaims.issuedAt, issuedAt),
          ),
        );
    },
    async due(before, limit) {
      const rows = await database
        .select()
        .from(githubClaims)
        .where(
          or(
            isNull(githubClaims.checkedAt),
            lt(githubClaims.checkedAt, before),
          ),
        )
        .orderBy(asc(githubClaims.checkedAt), asc(githubClaims.nodeId))
        .limit(limit);
      return rows.map(claimRow);
    },
    async list(limit) {
      const rows = await database
        .select({
          nodeId: githubClaims.nodeId,
          account: githubClaims.account,
          state: githubClaims.state,
        })
        .from(githubClaims)
        .orderBy(asc(githubClaims.nodeId))
        .limit(limit);
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        account: text(row.account),
        state: stateOf(row.state),
      }));
    },
  };
}
