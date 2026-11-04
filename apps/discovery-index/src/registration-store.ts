// Owns the enrollment storage contract (beta invites and the NodeIds they admitted) and its in-process
// adapter for tests and local runs; the D1 adapter is registration-store-d1.ts. Invites are kept only
// as SHA-256 hashes, and nothing here sees an IP or request header.
import {
  REDEEM_RESULTS,
  REGISTRATION_STATUS,
  type RedeemResult,
} from './constants';

export interface InviteInput {
  inviteHash: string;
  contact: string;
  createdAt: number;
  expiresAt: number;
}

export interface Redemption {
  inviteHash: string;
  nodeId: string;
  // What the 8004 registry bound to the NodeId, verified on chain before redeeming.
  owner: string;
  asset: string;
  country: string | null;
  now: number;
}

export interface RegistrationStore {
  createInvite(invite: InviteInput): Promise<void>;
  // An unused, unexpired invite: checked before the chain is read, so a bad code costs no RPC call.
  inviteUsable(inviteHash: string, now: number): Promise<boolean>;
  // Atomic: an unused, unexpired invite is spent on this NodeId and the NodeId becomes active. A NodeId
  // that is already active keeps its registration and spends no invite.
  redeem(redemption: Redemption): Promise<RedeemResult>;
  // Whether the NodeId may publish.
  active(nodeId: string): Promise<boolean>;
}

interface MemoryInvite extends InviteInput {
  usedAt: number | null;
  nodeId: string | null;
}

interface MemoryRegistration {
  owner: string;
  asset: string;
  status: string;
  inviteHash: string;
  country: string | null;
  registeredAt: number;
}

// Same semantics as the D1 adapter, in process memory. `revoke` mirrors the operator's SQL.
export function createMemoryRegistrationStore(): RegistrationStore & {
  revoke(nodeId: string): void;
} {
  const invites = new Map<string, MemoryInvite>();
  const registrations = new Map<string, MemoryRegistration>();
  const isActive = (nodeId: string) =>
    registrations.get(nodeId)?.status === REGISTRATION_STATUS.ACTIVE;
  return {
    async createInvite(invite) {
      if (invites.has(invite.inviteHash))
        throw new Error('Invite already exists.');
      invites.set(invite.inviteHash, { ...invite, usedAt: null, nodeId: null });
    },
    async inviteUsable(inviteHash, now) {
      const invite = invites.get(inviteHash);
      return !!invite && invite.usedAt === null && invite.expiresAt > now;
    },
    async redeem(redemption) {
      if (isActive(redemption.nodeId)) return REDEEM_RESULTS.ALREADY_ACTIVE;
      const invite = invites.get(redemption.inviteHash);
      if (
        !invite ||
        invite.usedAt !== null ||
        invite.expiresAt <= redemption.now
      )
        return REDEEM_RESULTS.INVITE_INVALID;
      invite.usedAt = redemption.now;
      invite.nodeId = redemption.nodeId;
      registrations.set(redemption.nodeId, {
        owner: redemption.owner,
        asset: redemption.asset,
        status: REGISTRATION_STATUS.ACTIVE,
        inviteHash: redemption.inviteHash,
        country: redemption.country,
        registeredAt: redemption.now,
      });
      return REDEEM_RESULTS.REGISTERED;
    },
    async active(nodeId) {
      return isActive(nodeId);
    },
    revoke(nodeId) {
      const registration = registrations.get(nodeId);
      if (registration) registration.status = REGISTRATION_STATUS.REVOKED;
    },
  };
}
