// Builds enrollment reads and writes with the shared ORM schema. Invite spending and admission
// remain one native D1 batch, and operator commands compile these same mutations.
import { and, eq, gt, isNull, notExists } from 'drizzle-orm';

import { REGISTRATION_STATUS, type RegistrationStatus } from './constants';
import type { DiscoveryDatabase } from './d1-client';
import type { InviteInput, Redemption } from './registration-store';
import { invites, registrations } from './schema';
import { valueField } from './sqlite-expressions';

export function createInviteQuery(
  database: DiscoveryDatabase,
  invite: InviteInput,
) {
  return database.insert(invites).values(invite);
}
export function registrationStatusQuery(
  database: DiscoveryDatabase,
  nodeId: string,
) {
  return database
    .select({ status: registrations.status })
    .from(registrations)
    .where(eq(registrations.nodeId, nodeId));
}
export function setRegistrationStatusQuery(
  database: DiscoveryDatabase,
  nodeId: string,
  status: RegistrationStatus,
) {
  return database
    .update(registrations)
    .set({ status })
    .where(eq(registrations.nodeId, nodeId));
}
export function inviteQuery(database: DiscoveryDatabase, inviteHash: string) {
  return database
    .select({
      usedAt: invites.usedAt,
      nodeId: invites.nodeId,
      expiresAt: invites.expiresAt,
      status: registrations.status,
    })
    .from(invites)
    .leftJoin(registrations, eq(registrations.nodeId, invites.nodeId))
    .where(eq(invites.inviteHash, inviteHash));
}
export function redemptionQueries(
  database: DiscoveryDatabase,
  redemption: Redemption,
) {
  const spend = database
    .update(invites)
    .set({ usedAt: redemption.now, nodeId: redemption.nodeId })
    .where(
      and(
        eq(invites.inviteHash, redemption.inviteHash),
        isNull(invites.usedAt),
        gt(invites.expiresAt, redemption.now),
        notExists(registrationStatusQuery(database, redemption.nodeId)),
      ),
    )
    .returning({ inviteHash: invites.inviteHash });
  const admit = database
    .insert(registrations)
    .select(
      database
        .select({
          nodeId: valueField(redemption.nodeId, 'nodeId'),
          owner: valueField(redemption.owner, 'owner'),
          asset: valueField(redemption.asset, 'asset'),
          status: valueField(REGISTRATION_STATUS.ACTIVE, 'status'),
          inviteHash: valueField(redemption.inviteHash, 'inviteHash'),
          country: valueField(redemption.country, 'country'),
          registeredAt: valueField(redemption.now, 'registeredAt'),
        })
        .from(invites)
        .where(
          and(
            eq(invites.inviteHash, redemption.inviteHash),
            eq(invites.nodeId, redemption.nodeId),
            eq(invites.usedAt, redemption.now),
          ),
        ),
    )
    .onConflictDoNothing({ target: registrations.nodeId });
  return [spend, admit] as const;
}
