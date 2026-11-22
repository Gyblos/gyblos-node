import { CONTROL_CODES, CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { verifyProfileClaim } from '@gyblos/protocol/profile-claim';

import { decodeUtf8, parseJson } from './body';
import { INDEX_ERRORS, REGISTRATION, SELLER_PROFILE } from './constants';
import { indexFail, protocolStep } from './errors';
import { known } from './github-claims';
import {
  sellerProfileTombstone,
  type SellerProfileStore,
} from './profile-store';
import type { RegistrationStore } from './registration-store';
import type { DiscoveryStorage } from './storage';

export interface SellerProfileContext {
  profiles: SellerProfileStore;
  storage: DiscoveryStorage;
  registrations: RegistrationStore | undefined;
  now: number;
}

async function verifiedProfile(bytes: ArrayBuffer, now: number) {
  const code = INDEX_ERRORS.INVALID_CLAIM;
  const body = parseJson(decodeUtf8(bytes, code), code);
  const signed = await protocolStep(
    () => verifyProfileClaim(body),
    (failure) =>
      failure === CONTROL_CODES.SIGNATURE
        ? INDEX_ERRORS.INVALID_SIGNATURE
        : code,
  );
  const { claim } = signed;
  if (claim.issuedAt > now + CONTROL_LIMITS.clockSkewMs) indexFail(code);
  if (claim.issuedAt < now - SELLER_PROFILE.maxAgeMs)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  return signed;
}

export async function submitSellerProfile(
  bytes: ArrayBuffer,
  context: SellerProfileContext,
): Promise<{ name: string | null }> {
  const { profiles, now } = context;
  const { claim, signature } = await verifiedProfile(bytes, now);
  const stored = await profiles.get(claim.nodeId);
  if (stored?.held) {
    if (claim.name === null) return { name: null };
    indexFail(INDEX_ERRORS.PROFILE_HELD);
  }
  if (stored && stored.issuedAt >= claim.issuedAt)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  if (claim.name === null) {
    if (!stored && !(await known(context, claim.nodeId))) return { name: null };
    if (
      !(await profiles.put(
        sellerProfileTombstone(claim.nodeId, claim.issuedAt),
      ))
    )
      indexFail(INDEX_ERRORS.STALE_CLAIM);
    return { name: null };
  }
  if (!(await known(context, claim.nodeId)))
    indexFail(INDEX_ERRORS.UNKNOWN_NODE);
  const written = await profiles.put({
    nodeId: claim.nodeId,
    name: claim.name,
    issuedAt: claim.issuedAt,
    signature,
    held: false,
  });
  if (!written) indexFail(INDEX_ERRORS.STALE_CLAIM);
  return { name: claim.name };
}

export function parseProfilePath(url: string, nodeId: string | undefined) {
  if (
    new URL(url).search !== '' ||
    nodeId === undefined ||
    !REGISTRATION.nodeId.test(nodeId)
  )
    return indexFail(INDEX_ERRORS.INVALID_QUERY);
  return nodeId;
}

export async function sellerProfilePage(
  context: Omit<SellerProfileContext, 'now'>,
  nodeId: string,
): Promise<string | null> {
  const row = await context.profiles.get(nodeId);
  if (!row || row.name === null || !(await known(context, nodeId))) return null;
  const { name, issuedAt, signature } = row;
  return JSON.stringify({ nodeId, name, issuedAt, signature });
}
