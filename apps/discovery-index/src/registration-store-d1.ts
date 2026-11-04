// Owns the Cloudflare D1 adapter of the enrollment storage contract (tables in migrations/0003).
// Redeeming is one D1 batch, so an invite is spent and its NodeId admitted together or not at all.
import { REDEEM_RESULTS, REGISTRATION_STATUS } from './constants';
import type { RegistrationStore } from './registration-store';
import type { D1Database } from './storage-d1';

const CREATE_INVITE_SQL = `INSERT INTO discovery_invites (invite_hash, contact, created_at, expires_at)
VALUES (?1, ?2, ?3, ?4)`;
const USABLE_SQL = `SELECT 1 AS usable FROM discovery_invites
WHERE invite_hash = ?1 AND used_at IS NULL AND expires_at > ?2`;
const ACTIVE_SQL = `SELECT 1 AS active FROM discovery_registrations WHERE node_id = ?1 AND status = '${REGISTRATION_STATUS.ACTIVE}'`;
// Spends the invite only while it is unused and unexpired.
const SPEND_SQL = `UPDATE discovery_invites SET used_at = ?3, node_id = ?2
WHERE invite_hash = ?1 AND used_at IS NULL AND expires_at > ?3`;
// Admits the NodeId only when the statement before spent this invite on it in this batch; a revoked
// NodeId is reactivated by a new invite.
const ADMIT_SQL = `INSERT INTO discovery_registrations (node_id, owner, asset, status, invite_hash, country, registered_at)
SELECT ?2, ?4, ?5, '${REGISTRATION_STATUS.ACTIVE}', ?1, ?6, ?3
WHERE EXISTS (SELECT 1 FROM discovery_invites WHERE invite_hash = ?1 AND node_id = ?2 AND used_at = ?3)
ON CONFLICT (node_id) DO UPDATE SET owner = excluded.owner, asset = excluded.asset,
  status = excluded.status, invite_hash = excluded.invite_hash, country = excluded.country,
  registered_at = excluded.registered_at`;

export function createD1RegistrationStore(
  database: D1Database,
): RegistrationStore {
  async function active(nodeId: string) {
    return (await database.prepare(ACTIVE_SQL).bind(nodeId).first()) !== null;
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
    async inviteUsable(inviteHash, now) {
      return (
        (await database.prepare(USABLE_SQL).bind(inviteHash, now).first()) !==
        null
      );
    },
    async redeem(redemption) {
      if (await active(redemption.nodeId)) return REDEEM_RESULTS.ALREADY_ACTIVE;
      const values = [
        redemption.inviteHash,
        redemption.nodeId,
        redemption.now,
        redemption.owner,
        redemption.asset,
        redemption.country,
      ] as const;
      const [spent] = await database.batch([
        database
          .prepare(SPEND_SQL)
          .bind(redemption.inviteHash, redemption.nodeId, redemption.now),
        database.prepare(ADMIT_SQL).bind(...values),
      ]);
      return spent!.meta.changes === 1
        ? REDEEM_RESULTS.REGISTERED
        : REDEEM_RESULTS.INVITE_INVALID;
    },
    active,
  };
}
