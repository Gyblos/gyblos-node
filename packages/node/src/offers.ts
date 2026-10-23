// Signs private inference offers with the owner's Solana wallet key and verifies them against the trusted owner.
// Wire shape, domain, signing bytes and Ed25519 stay in protocol; trust policy stays in core.
import {
  address,
  createSignableMessage,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

import { validateInferenceOffer, type OfferTrust } from '@gyblos/core/offers';
import { OFFER_DOMAIN } from '@gyblos/protocol/constants';
import type {
  InferenceOffer,
  SignedInferenceOffer,
} from '@gyblos/protocol/offer';
import { sign, verify } from '@gyblos/protocol/signing';

export async function signInferenceOffer(
  offer: InferenceOffer,
  owner: KeyPairSigner,
): Promise<SignedInferenceOffer> {
  if (owner.address !== offer.owner)
    throw new Error('Offer signer does not match owner.');
  const signature = await sign(OFFER_DOMAIN, offer, async (bytes) => {
    const signatures = await owner.signMessages([createSignableMessage(bytes)]);
    return signatures[0]![owner.address]!;
  });
  return {
    offer,
    signature: Buffer.from(signature).toString('base64'),
  };
}

export async function verifyInferenceOffer(
  value: unknown,
  trust: OfferTrust,
  now = Date.now(),
): Promise<InferenceOffer> {
  const signed = value as SignedInferenceOffer;
  const offer = validateInferenceOffer(value, trust, now, address);
  if (
    !(await verify(
      OFFER_DOMAIN,
      offer,
      Uint8Array.from(getAddressEncoder().encode(address(trust.owner))),
      Buffer.from(signed.signature, 'base64'),
    ))
  )
    throw new Error('Invalid owner signature.');
  return offer;
}
