// Owns the enrollment storage contract (beta invites and the NodeIds they admitted) and its in-process
// adapter for tests and local runs; the D1 adapter is registration-store-d1.ts. Invites are kept only
// as SHA-256 hashes, and nothing here sees an IP or request header.
import {
  INVITE_STATES,
  REDEEM_RESULTS,
  REGISTRATION_STATUS,
  type InviteState,
  type RedeemResult,
  type RegistrationStatus,
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
  // The operator's insert (scripts/admin.ts writes the same row through Wrangler); tests seed with it.
  createInvite(invite: InviteInput): Promise<void>;
  // Checked before the chain is read, so a bad code costs no RPC call and reveals nothing about NodeIds.
  inviteState(
    inviteHash: string,
    nodeId: string,
    now: number,
  ): Promise<InviteState>;
  // Atomic: an unused, unexpired invite is spent and the NodeId admitted only when the NodeId has no
  // registration yet. An active NodeId spends nothing; a revoked one stays revoked.
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
  status: RegistrationStatus;
  inviteHash: string;
  country: string | null;
  registeredAt: number;
}

export interface StoredInvite {
  usedAt: number | null;
  nodeId: string | null;
  expiresAt: number;
}

// The invite's state for this NodeId from its stored row and the registration it admitted, if any.
export function inviteStateOf(
  invite: StoredInvite | null,
  admittedStatus: string | null,
  nodeId: string,
  now: number,
): InviteState {
  if (!invite) return INVITE_STATES.INVALID;
  if (invite.usedAt === null)
    return invite.expiresAt > now
      ? INVITE_STATES.USABLE
      : INVITE_STATES.INVALID;
  return invite.nodeId === nodeId &&
    admittedStatus === REGISTRATION_STATUS.ACTIVE
    ? INVITE_STATES.ADMITTED
    : INVITE_STATES.INVALID;
}

// Same semantics as the D1 adapter, in process memory. `setStatus` mirrors the operator's SQL.
export function createMemoryRegistrationStore(): RegistrationStore & {
  setStatus(nodeId: string, status: RegistrationStatus): void;
} {
  const invites = new Map<string, MemoryInvite>();
  const registrations = new Map<string, MemoryRegistration>();
  return {
    async createInvite(invite) {
      if (invites.has(invite.inviteHash))
        throw new Error('Invite already exists.');
      invites.set(invite.inviteHash, { ...invite, usedAt: null, nodeId: null });
    },
    async inviteState(inviteHash, nodeId, now) {
      const invite = invites.get(inviteHash) ?? null;
      const admitted = invite?.nodeId
        ? registrations.get(invite.nodeId)
        : undefined;
      return inviteStateOf(invite, admitted?.status ?? null, nodeId, now);
    },
    async redeem(redemption) {
      const existing = registrations.get(redemption.nodeId);
      if (existing)
        return existing.status === REGISTRATION_STATUS.ACTIVE
          ? REDEEM_RESULTS.ALREADY_ACTIVE
          : REDEEM_RESULTS.REVOKED;
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
      return registrations.get(nodeId)?.status === REGISTRATION_STATUS.ACTIVE;
    },
    setStatus(nodeId, status) {
      const registration = registrations.get(nodeId);
      if (registration) registration.status = status;
    },
  };
}
