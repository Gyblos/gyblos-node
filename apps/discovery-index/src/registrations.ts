// Owns POST /v1/registrations: a beta seller trades a one-use invite for permission to publish, once the
// index has read its 8004-solana registration on chain and found the NodeId bound there. The invite is
// hashed before it touches storage; the chain, not the request, says which owner and asset are stored.
import { IDENTITY_LOOKUP_KINDS } from '@gyblos/core/constants';
import type { IdentityLookup } from '@gyblos/core/identity-policy';

import {
  HEX,
  INDEX_ERRORS,
  REDEEM_RESULTS,
  REGISTRATION,
  type RedeemResult,
} from './constants';
import { indexFail } from './errors';
import type { RegistrationStore } from './registration-store';

// Reads the NodeId's binding from the 8004 registry (the Worker wires readRegistryIdentity).
export interface RegistryReader {
  lookup(nodeId: string): Promise<IdentityLookup>;
}

export interface RegistrationContext {
  store: RegistrationStore;
  registry: RegistryReader;
  now: number;
  // Cloudflare's request country, when present.
  country: unknown;
}

const BODY_KEYS = ['invite', 'nodeId'];

function readRequest(bytes: ArrayBuffer) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return indexFail(INDEX_ERRORS.INVALID_REGISTRATION);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== BODY_KEYS.join()
  )
    return indexFail(INDEX_ERRORS.INVALID_REGISTRATION);
  const { invite, nodeId } = value as Record<string, unknown>;
  if (
    typeof invite !== 'string' ||
    !REGISTRATION.invite.test(invite) ||
    typeof nodeId !== 'string' ||
    !REGISTRATION.nodeId.test(nodeId)
  )
    return indexFail(INDEX_ERRORS.INVALID_REGISTRATION);
  return { invite, nodeId };
}

export async function inviteHash(invite: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(invite),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX.radix).padStart(HEX.byteWidth, '0'))
    .join('');
}

// The registry's owner and asset for the NodeId; a missing binding refuses, an outage is a 503.
async function chainBinding(registry: RegistryReader, nodeId: string) {
  const lookup = await registry.lookup(nodeId);
  if (lookup.kind === IDENTITY_LOOKUP_KINDS.MISSING)
    return indexFail(INDEX_ERRORS.IDENTITY_NOT_REGISTERED);
  if (
    lookup.kind !== IDENTITY_LOOKUP_KINDS.BOUND ||
    lookup.binding.nodeId !== nodeId
  )
    return indexFail(INDEX_ERRORS.UNAVAILABLE);
  return lookup.binding;
}

// Throws IndexError with a static code; storage failures propagate (503).
export async function registerSeller(
  bytes: ArrayBuffer,
  context: RegistrationContext,
): Promise<RedeemResult> {
  const { invite, nodeId } = readRequest(bytes);
  const { store, now } = context;
  const hash = await inviteHash(invite);
  // An active NodeId answers without reading the chain or spending the invite.
  if (await store.active(nodeId)) return REDEEM_RESULTS.ALREADY_ACTIVE;
  if (!(await store.inviteUsable(hash, now)))
    indexFail(INDEX_ERRORS.INVITE_INVALID);
  const binding = await chainBinding(context.registry, nodeId);
  const result = await store.redeem({
    inviteHash: hash,
    nodeId,
    owner: binding.owner,
    asset: binding.asset,
    country:
      typeof context.country === 'string' &&
      REGISTRATION.country.test(context.country)
        ? context.country
        : null,
    now,
  });
  if (result === REDEEM_RESULTS.INVITE_INVALID)
    indexFail(INDEX_ERRORS.INVITE_INVALID);
  return result;
}
