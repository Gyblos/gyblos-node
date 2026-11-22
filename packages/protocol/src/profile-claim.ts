import { CONTROL_CODES, CONTROL_LIMITS } from './constants';
import {
  controlFail,
  controlHex,
  controlInteger,
  controlObject,
  controlVerify,
} from './control-validation';
import {
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
  type SellerNameIssue,
} from './profile-claim/constants';
import { bytesHex, hexBytes } from './public-validation';
import { sign, type Signer } from './signing';

export {
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
  type SellerNameIssue,
} from './profile-claim/constants';

export interface ProfileClaimV1 {
  schemaVersion: typeof PROFILE_CLAIM.schemaVersion;
  nodeId: string;
  name: string | null;
  issuedAt: number;
}
export interface SignedProfileClaim {
  claim: ProfileClaimV1;
  signature: string;
}
export type SellerNameResult =
  { ok: true; name: string } | { ok: false; issue: SellerNameIssue };

const CLAIM_KEYS = ['schemaVersion', 'nodeId', 'name', 'issuedAt'] as const;

const refused = (issue: SellerNameIssue): SellerNameResult => ({
  ok: false,
  issue,
});

export function parseSellerName(value: unknown): SellerNameResult {
  if (typeof value !== 'string') return refused(SELLER_NAME_ISSUES.CHARACTERS);
  if (value.length > PROFILE_CLAIM.maxInputCharacters)
    return refused(SELLER_NAME_ISSUES.LENGTH);
  const normalized = value.normalize(PROFILE_CLAIM.normalization);
  if (PROFILE_CLAIM.forbidden.test(normalized))
    return refused(SELLER_NAME_ISSUES.CHARACTERS);
  const name = normalized.replace(PROFILE_CLAIM.spaces, ' ').trim();
  const characters = [...name].length;
  if (
    characters < PROFILE_CLAIM.minNameCharacters ||
    characters > PROFILE_CLAIM.maxNameCharacters
  )
    return refused(SELLER_NAME_ISSUES.LENGTH);
  if (
    !PROFILE_CLAIM.allowed.test(name) ||
    !PROFILE_CLAIM.letterOrNumber.test(name)
  )
    return refused(SELLER_NAME_ISSUES.CHARACTERS);
  if (name.toLowerCase().includes(PROFILE_CLAIM.reservedWord))
    return refused(SELLER_NAME_ISSUES.RESERVED);
  return { ok: true, name };
}

function canonicalName(value: unknown): string | null {
  if (value === null) return null;
  const result = parseSellerName(value);
  return result.ok && result.name === value ? result.name : controlFail();
}

export function parseProfileClaim(value: unknown): ProfileClaimV1 {
  const input = controlObject(value, CLAIM_KEYS);
  if (input.schemaVersion !== PROFILE_CLAIM.schemaVersion)
    return controlFail(CONTROL_CODES.VERSION);
  return {
    schemaVersion: PROFILE_CLAIM.schemaVersion,
    nodeId: controlHex(input.nodeId),
    name: canonicalName(input.name),
    issuedAt: controlInteger(input.issuedAt),
  };
}

export async function signProfileClaim(
  value: ProfileClaimV1,
  signer: Signer,
): Promise<SignedProfileClaim> {
  const claim = parseProfileClaim(value);
  const signature = Uint8Array.from(
    await sign(PROFILE_CLAIM.domain, claim, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(
      PROFILE_CLAIM.domain,
      claim,
      hexBytes(claim.nodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { claim, signature: bytesHex(signature) };
}

export async function verifyProfileClaim(
  value: unknown,
): Promise<SignedProfileClaim> {
  const input = controlObject(value, ['claim', 'signature']);
  const claim = parseProfileClaim(input.claim);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      PROFILE_CLAIM.domain,
      claim,
      hexBytes(claim.nodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { claim, signature };
}
