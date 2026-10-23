// Signs private inference offers with the owner's Solana wallet key and verifies them against the trusted owner.
// Trust policy stays in core; signing bytes and Ed25519 stay in protocol.
import {
  address,
  createSignableMessage,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

import { MAX_ATOMIC } from '@gyblos/config';
import { validateInferenceOffer, type OfferTrust } from '@gyblos/core/offers';
import { OFFER_DOMAIN } from '@gyblos/protocol/constants';
import type {
  InferenceOffer,
  SignedInferenceOffer,
} from '@gyblos/protocol/offer';
import { sign, verify } from '@gyblos/protocol/signing';

import {
  configurationAddress,
  configurationJson,
  configurationNodeId,
  configurationObject,
  configurationString,
} from './configuration.js';
import { NODE_ERROR_CODES } from './constants.js';
import { NodeError } from './errors.js';

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

// Trust is supplied independently by the buyer; never infer trusted identities from an unverified offer.
export function parseOfferTrust(value: unknown): OfferTrust {
  const code = NODE_ERROR_CODES.INVALID_OFFER_TRUST;
  const input = configurationObject(value, code, [
    'owner',
    'nodeId',
    'mint',
    'payTo',
    'buyer',
    'maxAtomic',
  ]);
  const maxAtomic = configurationString(input.maxAtomic, code);
  if (
    /[^0-9]/.test(maxAtomic) ||
    maxAtomic.startsWith('0') ||
    BigInt(maxAtomic) <= 0n ||
    BigInt(maxAtomic) > BigInt(MAX_ATOMIC)
  )
    throw new NodeError(code);
  return {
    owner: configurationAddress(input.owner, code),
    nodeId: configurationNodeId(input.nodeId, code),
    mint: configurationAddress(input.mint, code),
    payTo: configurationAddress(input.payTo, code),
    buyer: configurationAddress(input.buyer, code),
    maxAtomic,
  };
}

export function parseOfferTrustJson(text: string): OfferTrust {
  return parseOfferTrust(
    configurationJson(text, NODE_ERROR_CODES.INVALID_OFFER_TRUST),
  );
}

// Decode untrusted offer text without including malformed payload fragments in diagnostics.
export function parseSignedOfferJson(text: string): unknown {
  return configurationJson(text, NODE_ERROR_CODES.INVALID_SIGNED_OFFER);
}
