// Owns the Cloudflare D1 adapter of the enrollment storage contract (tables in migrations/0003).
// Redeeming is one D1 batch, so an invite is spent and its NodeId admitted together or not at all.
import { REDEEM_RESULTS, REGISTRATION_STATUS } from './constants';
import {
  inviteStateOf,
  type RegistrationStore,
  type StoredInvite,
} from './registration-store';
import type { D1Database, D1Row } from './storage-d1';

const CREATE_INVITE_SQL = `INSERT INTO discovery_invites (invite_hash, contact, created_at, expires_at)
VALUES (?1, ?2, ?3, ?4)`;
const INVITE_SQL = `SELECT i.used_at AS usedAt, i.node_id AS nodeId, i.expires_at AS expiresAt, r.status AS status
FROM discovery_invites i LEFT JOIN discovery_registrations r ON r.node_id = i.node_id
WHERE i.invite_hash = ?1`;
const STATUS_SQL = `SELECT status FROM discovery_registrations WHERE node_id = ?1`;
// Spends the invite only while it is unused and unexpired and the NodeId has no registration at all, so
// a revoked NodeId is never readmitted by an invite.
const SPEND_SQL = `UPDATE discovery_invites SET used_at = ?3, node_id = ?2
WHERE invite_hash = ?1 AND used_at IS NULL AND expires_at > ?3
  AND NOT EXISTS (SELECT 1 FROM discovery_registrations WHERE node_id = ?2)`;
// Admits the NodeId only when the statement before spent this invite on it in this batch.
const ADMIT_SQL = `INSERT INTO discovery_registrations (node_id, owner, asset, status, invite_hash, country, registered_at)
SELECT ?2, ?4, ?5, '${REGISTRATION_STATUS.ACTIVE}', ?1, ?6, ?3
WHERE EXISTS (SELECT 1 FROM discovery_invites WHERE invite_hash = ?1 AND node_id = ?2 AND used_at = ?3)
ON CONFLICT (node_id) DO NOTHING`;

// Storage rows are our own, but a corrupted row must fail closed (503), not be trusted.
function unexpected(): never {
  throw new TypeError('Unexpected registration row.');
}
function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : unexpected();
}
function nullableText(value: unknown): string | null {
  return value === null || typeof value === 'string' ? value : unexpected();
}

function inviteRow(row: D1Row | null): {
  invite: StoredInvite | null;
  status: string | null;
} {
  if (!row) return { invite: null, status: null };
  return {
    invite: {
      usedAt: nullableInteger(row.usedAt),
      nodeId: nullableText(row.nodeId),
      expiresAt: nullableInteger(row.expiresAt) ?? unexpected(),
    },
    status: nullableText(row.status),
  };
}

export function createD1RegistrationStore(
  database: D1Database,
): RegistrationStore {
  async function status(nodeId: string) {
    const row = await database.prepare(STATUS_SQL).bind(nodeId).first();
    return row ? nullableText(row.status) : null;
  }
  return {
    async createInvite(invite) {
      await database
        .prepare(CREATE_INVITE_SQL)
        .bind(
          invite.inviteHash,
          invite.contact,
          invite.createdAt,
          invite.expiresAt,
        )
        .run();
    },
    async inviteState(inviteHash, nodeId, now) {
      const { invite, status: admitted } = inviteRow(
        await database.prepare(INVITE_SQL).bind(inviteHash).first(),
      );
      return inviteStateOf(invite, admitted, nodeId, now);
    },
    async redeem(redemption) {
      const current = await status(redemption.nodeId);
      if (current === REGISTRATION_STATUS.ACTIVE)
        return REDEEM_RESULTS.ALREADY_ACTIVE;
      if (current !== null) return REDEEM_RESULTS.REVOKED;
      const [spent] = await database.batch([
        database
          .prepare(SPEND_SQL)
          .bind(redemption.inviteHash, redemption.nodeId, redemption.now),
        database
          .prepare(ADMIT_SQL)
          .bind(
            redemption.inviteHash,
            redemption.nodeId,
            redemption.now,
            redemption.owner,
            redemption.asset,
            redemption.country,
          ),
      ]);
      if (spent!.meta.changes === 1) return REDEEM_RESULTS.REGISTERED;
      // Lost a race: another request registered or revoked the NodeId meanwhile, or spent the invite.
      const after = await status(redemption.nodeId);
      if (after === REGISTRATION_STATUS.ACTIVE)
        return REDEEM_RESULTS.ALREADY_ACTIVE;
      return after === null
        ? REDEEM_RESULTS.INVITE_INVALID
        : REDEEM_RESULTS.REVOKED;
    },
    async active(nodeId) {
      return (await status(nodeId)) === REGISTRATION_STATUS.ACTIVE;
    },
  };
}
