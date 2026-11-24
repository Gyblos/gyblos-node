// A release declaration travels beside a v2 presence so existing verifiers receive identical bytes.
import {
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  SELLER_VERSION,
} from './constants';
import type { SignedPublicV2 } from './control-types';
import { bytesHex, hexBytes } from './public-validation';
import { sign, verify, type Signer } from './signing';

export const SELLER_RELEASE_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const signatureCharacters =
  PUBLIC_RECORD_LIMITS.signatureBytes *
  PUBLIC_RECORD_LIMITS.hexCharactersPerByte;
function validRelease(version: string | undefined): version is string {
  return (
    !!version &&
    version.length <= SELLER_VERSION.maxCharacters &&
    SELLER_RELEASE_PATTERN.test(version)
  );
}

export async function sellerVersionProof(
  presence: SignedPublicV2,
  version: string | undefined,
  signer: Signer,
) {
  if (
    presence.record.kind !== PUBLIC_RECORD_KINDS.PRESENCE ||
    !validRelease(version)
  )
    return undefined;
  const signature = await sign(
    SELLER_VERSION.domain,
    { presenceSignature: presence.signature, version },
    signer,
  );
  return version + ':' + bytesHex(signature);
}

export async function verifiedSellerVersion(
  presence: SignedPublicV2,
  proof?: string,
) {
  if (
    presence.record.kind !== PUBLIC_RECORD_KINDS.PRESENCE ||
    !proof ||
    proof.length > SELLER_VERSION.maxCharacters + 1 + signatureCharacters
  )
    return null;
  const separator = proof.indexOf(':');
  const version = proof.slice(0, separator);
  const signature = proof.slice(separator + 1);
  if (
    !validRelease(version) ||
    separator < 1 ||
    signature.length !== signatureCharacters ||
    !/^[0-9a-f]+$/u.test(signature)
  )
    return null;
  const valid = await verify(
    SELLER_VERSION.domain,
    { presenceSignature: presence.signature, version },
    hexBytes(presence.record.nodeId),
    hexBytes(signature),
  );
  return valid ? version : null;
}
