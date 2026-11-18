// Owns the Cloudflare D1 adapter of the enrollment storage contract (tables in migrations/0003).
// Redeeming is one D1 batch, so an invite is spent and its NodeId admitted together or not at all.
import {
  REDEEM_RESULTS,
  REGISTRATION_STATUS,
  type RegistrationStatus,
} from './constants';
import { createD1Orm } from './d1-client';
import {
  createInviteQuery,
  inviteQuery,
  redemptionQueries,
  registeredQuery,
  registrationStatusQuery,
} from './registration-queries';
import {
  inviteStateOf,
  type RegistrationStore,
  type StoredInvite,
} from './registration-store';
import type { D1Database, D1Row } from './storage-d1';

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
  client: D1Database,
): RegistrationStore {
  const database = createD1Orm(client);
  async function status(nodeId: string) {
    const [row] = await registrationStatusQuery(database, nodeId);
    return row ? nullableText(row.status) : null;
  }
  return {
    async createInvite(invite) {
      await createInviteQuery(database, invite);
    },
    async inviteState(inviteHash, nodeId, now) {
      const { invite, status: admitted } = inviteRow(
        (await inviteQuery(database, inviteHash))[0] ?? null,
      );
      return inviteStateOf(invite, admitted, nodeId, now);
    },
    async redeem(redemption) {
      const current = await status(redemption.nodeId);
      if (current === REGISTRATION_STATUS.ACTIVE)
        return REDEEM_RESULTS.ALREADY_ACTIVE;
      if (current !== null) return REDEEM_RESULTS.REVOKED;
      const [spent] = await database.batch(
        redemptionQueries(database, redemption),
      );
      if (spent.length === 1) return REDEEM_RESULTS.REGISTERED;
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
    async registered(limit) {
      const ids = async (status: RegistrationStatus) =>
        (await registeredQuery(database, status, limit)).map(
          (row) => nullableText(row.nodeId) ?? unexpected(),
        );
      const [active, revoked] = await Promise.all([
        ids(REGISTRATION_STATUS.ACTIVE),
        ids(REGISTRATION_STATUS.REVOKED),
      ]);
      return { active, revoked };
    },
  };
}
