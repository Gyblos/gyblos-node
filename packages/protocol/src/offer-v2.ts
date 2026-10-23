// Signs private quote terms with the owner key; no quote authorizes payment or reserves capacity.
import { CONTROL_CODES, CONTROL_DOMAINS, CONTROL_LIMITS } from './constants.js';
import type { InferenceOfferV2, SignedOfferV2 } from './control-types.js';
import {
  controlFail,
  controlInteger,
  controlObject,
} from './control-validation.js';
import { parseOfferV2 } from './offer-v2-parser.js';
import { publicAddressBytes } from './public-validation.js';
import { sign, verify, type Signer } from './signing.js';

export { parseOfferV2 } from './offer-v2-parser.js';
function base64Encode(bytes: Readonly<Uint8Array>): string {
  return btoa(String.fromCharCode(...bytes));
}
function signatureV2(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') return controlFail(CONTROL_CODES.SIGNATURE);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return controlFail(CONTROL_CODES.SIGNATURE);
  }
  if (
    bytes.length !== CONTROL_LIMITS.signatureBytes ||
    base64Encode(bytes) !== value
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return bytes;
}
export function validateOfferV2Time(offer: InferenceOfferV2, now: number) {
  controlInteger(now);
  if (
    offer.issuedAt > now ||
    offer.expiresAt <= now ||
    offer.expiresAt <= offer.issuedAt ||
    offer.expiresAt - offer.issuedAt > CONTROL_LIMITS.quoteLifetimeMs ||
    offer.availability.observedAt > offer.issuedAt
  )
    return controlFail(CONTROL_CODES.EXPIRED);
}
export async function signOfferV2(
  value: InferenceOfferV2,
  signer: Signer,
): Promise<SignedOfferV2> {
  const offer = parseOfferV2(value);
  validateOfferV2Time(offer, offer.issuedAt);
  const signature = await sign(CONTROL_DOMAINS.OFFER, offer, signer);
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await verify(
      CONTROL_DOMAINS.OFFER,
      offer,
      publicAddressBytes(offer.owner),
      Uint8Array.from(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { offer, signature: base64Encode(signature) };
}
export async function verifyOfferV2(
  value: unknown,
  trust: { owner: string; nodeId: string; now: number },
): Promise<InferenceOfferV2> {
  const input = controlObject(value, ['offer', 'signature']);
  const offer = parseOfferV2(input.offer);
  if (offer.owner !== trust.owner || offer.nodeId !== trust.nodeId)
    return controlFail(CONTROL_CODES.POLICY);
  validateOfferV2Time(offer, trust.now);
  if (
    !(await verify(
      CONTROL_DOMAINS.OFFER,
      offer,
      publicAddressBytes(trust.owner),
      signatureV2(input.signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return offer;
}
