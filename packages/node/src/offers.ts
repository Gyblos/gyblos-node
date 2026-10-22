// Owns the unchanged Solana wallet adaptation for private signed offers.
// Trust policy stays in core; signing bytes and Ed25519 stay in protocol.
import {
  address,
  createSignableMessage,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

import {
  validateInferenceOffer,
  type InferenceOffer,
  type OfferTrust,
  type SignedInferenceOffer,
} from '@gyblos/application/offers';
import { P2P } from '@gyblos/config';
import { sign, verify } from '@gyblos/protocol/signing';

export type {
  InferenceOffer,
  OfferTrust,
  SignedInferenceOffer,
} from '@gyblos/application/offers';

export async function signInferenceOffer(
  offer: InferenceOffer,
  owner: KeyPairSigner,
): Promise<SignedInferenceOffer> {
  if (owner.address !== offer.owner)
    throw new Error('Offer signer does not match owner.');
  const signature = await sign(P2P.offerDomain, offer, async (bytes) => {
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
      P2P.offerDomain,
      offer,
      Uint8Array.from(getAddressEncoder().encode(address(trust.owner))),
      Buffer.from(signed.signature, 'base64'),
    ))
  )
    throw new Error('Invalid owner signature.');
  return offer;
}
