// Owns derivation of 8004 program addresses (agent PDA, metadata PDA, key hash).
// Must not know about RPC, signing or account decoding.
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from '@solana/kit';

import { utf8 } from './bytes.js';
import { LIMITS, PROGRAMS, SEEDS } from './constants.js';

const ADDRESS_ENCODER = getAddressEncoder();

export async function metadataKeyHash(key: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(utf8(key)),
  );
  return new Uint8Array(digest).slice(0, LIMITS.keyHashBytes);
}

export async function findAgentAddress(asset: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.registry,
    seeds: [SEEDS.agent, ADDRESS_ENCODER.encode(asset)],
  });
  return pda;
}

export async function findMetadataAddress(
  asset: Address,
  key: string,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.registry,
    seeds: [
      SEEDS.metadata,
      ADDRESS_ENCODER.encode(asset),
      await metadataKeyHash(key),
    ],
  });
  return pda;
}
