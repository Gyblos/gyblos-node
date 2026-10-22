import {
  address,
  createSignableMessage,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

import {
  DEVNET,
  INFERENCE_REQUEST_LIMITS,
  MAX_ATOMIC,
  P2P,
} from '@gyblos/config';
import { sign, verify } from '@gyblos/protocol/signing';

import type { EngineCapabilities, EngineDescription } from './engine.js';
import { PRICES } from './metering.js';

export interface InferenceOffer {
  schemaVersion: number;
  protocol: string;
  owner: string;
  nodeId: string;
  endpoint: { relayUrl: string | null; directAddresses: string[] };
  relayOnly: boolean;
  network: string;
  mint: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  buyer: string;
  issuedAt: number;
  expiresAt: number;
  prices: { inputAtomic: string; outputAtomic: string };
  maxAtomic: string;
  maxTokens: number;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  meteringMode: 'recounted' | 'declared';
}

export interface SignedInferenceOffer {
  offer: InferenceOffer;
  signature: string;
}

export interface OfferTrust {
  owner: string;
  nodeId: string;
  mint: string;
  payTo: string;
  buyer: string;
  maxAtomic: string;
}

function validOffer(offer: InferenceOffer, trust: OfferTrust, now: number) {
  if (
    offer.schemaVersion !== P2P.schemaVersion ||
    offer.protocol !== P2P.protocol ||
    offer.owner !== trust.owner ||
    offer.nodeId !== trust.nodeId ||
    offer.network !== DEVNET ||
    offer.mint !== trust.mint ||
    offer.payTo !== trust.payTo ||
    offer.buyer !== trust.buyer
  )
    throw new Error('Untrusted signed offer identity or payment terms.');
  if (
    !Number.isSafeInteger(offer.issuedAt) ||
    !Number.isSafeInteger(offer.expiresAt) ||
    offer.issuedAt > now ||
    offer.expiresAt <= now ||
    offer.expiresAt - offer.issuedAt > P2P.offerLifetimeMs
  )
    throw new Error('Expired or invalid offer lifetime.');
  if (
    !/^\d+$/.test(offer.maxAtomic) ||
    BigInt(offer.maxAtomic) > BigInt(trust.maxAtomic) ||
    BigInt(offer.maxAtomic) > BigInt(MAX_ATOMIC) ||
    BigInt(offer.maxAtomic) <= 0n
  )
    throw new Error('Offer exceeds the local budget.');
  if (
    offer.prices.inputAtomic !== PRICES.inputAtomic ||
    offer.prices.outputAtomic !== PRICES.outputAtomic
  )
    throw new Error('Unexpected inference prices.');
  if (
    !Number.isSafeInteger(offer.maxTokens) ||
    offer.maxTokens < INFERENCE_REQUEST_LIMITS.minOutputTokens ||
    offer.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens ||
    !Number.isSafeInteger(offer.model.contextTokens) ||
    offer.model.contextTokens < offer.maxTokens ||
    !offer.model.name ||
    !offer.model.digest
  )
    throw new Error('Invalid model or token bounds.');
  if (
    offer.capabilities.reportsUsage !== true ||
    offer.capabilities.recountable !== true ||
    offer.capabilities.cancellable !== true ||
    typeof offer.capabilities.logprobs !== 'boolean' ||
    offer.capabilities.modelIdentity !== 'digest' ||
    offer.meteringMode !== 'recounted'
  )
    throw new Error('This PoC requires recountable usage and digest identity.');
  if ([offer.owner, offer.feePayer, offer.authorizer].includes(offer.payTo))
    throw new Error('Payout must be distinct from hot wallet keys.');
  for (const wallet of [
    offer.owner,
    offer.payTo,
    offer.mint,
    offer.feePayer,
    offer.authorizer,
    offer.buyer,
  ])
    address(wallet);
  if (
    typeof offer.relayOnly !== 'boolean' ||
    !Array.isArray(offer.endpoint.directAddresses) ||
    offer.endpoint.directAddresses.some((value) => typeof value !== 'string')
  )
    throw new Error('Invalid endpoint declaration.');
  if (offer.endpoint.relayUrl !== null) {
    const relay = new URL(offer.endpoint.relayUrl);
    if (
      relay.protocol !== 'https:' ||
      relay.username ||
      relay.password ||
      relay.search ||
      relay.hash
    )
      throw new Error('Invalid relay origin.');
  }
  if (offer.relayOnly && offer.endpoint.directAddresses.length)
    throw new Error('Relay-only offers must not advertise direct addresses.');
}

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
  if (
    !signed?.offer ||
    typeof signed.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signature)
  )
    throw new Error('Malformed signed offer.');
  const offer = signed.offer;
  validOffer(offer, trust, now);
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
