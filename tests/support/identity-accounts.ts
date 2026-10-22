// Owns synthetic 8004 account bytes (AgentAccount, Core AssetV1, MetadataEntryPda) and claimant builders.
// Synthetic data only: no network, funded wallets or private keys; layouts mirror @gyblos/identity/accounts.
import { getAddressEncoder, type Address } from '@solana/kit';

import type { DetachedSigner } from '@gyblos/identity';
import { encodeBindingValue, signNodeBinding } from '@gyblos/identity/binding';
import {
  concatBytes,
  encodeBool,
  encodeString,
  encodeVecU8,
} from '@gyblos/identity/bytes';
import {
  ACCOUNT_DISCRIMINATORS,
  DEVNET_REGISTRY,
  METADATA_KEYS,
  MPL_CORE_ASSET_V1_KEY,
  PROGRAMS,
} from '@gyblos/identity/constants';
import { findAgentAddress, findMetadataAddress } from '@gyblos/identity/pda';

const ADDRESS_ENCODER = getAddressEncoder();
const REPUTATION_DIGESTS_BYTES = 3 * (32 + 8);
const CORE_TAIL_BYTES = 16;
// The Uninitialized key a burned Core asset may leave behind in a 1-byte account.
const CORE_UNINITIALIZED_KEY = 0;

export interface SyntheticAccount {
  owner: Address;
  data: Uint8Array;
}

export type SyntheticChain = Map<Address, SyntheticAccount>;

export interface AgentFields {
  collection: Address;
  creator: Address;
  owner: Address;
  asset: Address;
  agentWallet?: Address;
  uri: string;
}

function addressBytes(value: Address): Uint8Array {
  return new Uint8Array(ADDRESS_ENCODER.encode(value));
}

function optionalAddress(value: Address | undefined): Uint8Array {
  return value === undefined
    ? encodeBool(false)
    : concatBytes([encodeBool(true), addressBytes(value)]);
}

export function agentAccountBytes(fields: AgentFields): Uint8Array {
  const bump = 255;
  return concatBytes([
    ACCOUNT_DISCRIMINATORS.agent,
    addressBytes(fields.collection),
    addressBytes(fields.creator),
    addressBytes(fields.owner),
    addressBytes(fields.asset),
    Uint8Array.of(bump),
    encodeBool(false),
    optionalAddress(fields.agentWallet),
    new Uint8Array(REPUTATION_DIGESTS_BYTES),
    optionalAddress(undefined),
    encodeBool(false),
    encodeBool(false),
    encodeString(fields.uri),
    encodeString('Agent'),
    encodeString(''),
  ]);
}

export function coreAssetBytes(owner: Address): Uint8Array {
  return concatBytes([
    Uint8Array.of(MPL_CORE_ASSET_V1_KEY),
    addressBytes(owner),
    new Uint8Array(CORE_TAIL_BYTES),
  ]);
}

export function burnedCoreAssetBytes(): Uint8Array {
  return Uint8Array.of(CORE_UNINITIALIZED_KEY);
}

export function metadataBytes(
  asset: Address,
  key: string,
  value: Uint8Array,
): Uint8Array {
  const bump = 255;
  return concatBytes([
    ACCOUNT_DISCRIMINATORS.metadata,
    addressBytes(asset),
    encodeBool(false),
    Uint8Array.of(bump),
    encodeString(key),
    encodeVecU8(value),
  ]);
}

export interface ClaimantSpec {
  owner: Address;
  asset: Address;
  node: DetachedSigner;
  collection?: Address;
}

export interface ClaimantAddresses {
  agent: Address;
  core: Address;
  metadata: Address;
}

// Writes a well-formed registered agent with a valid node binding; tests then break one piece.
export async function addClaimant(
  chain: SyntheticChain,
  spec: ClaimantSpec,
): Promise<ClaimantAddresses> {
  const addresses: ClaimantAddresses = {
    agent: await findAgentAddress(spec.asset),
    core: spec.asset,
    metadata: await findMetadataAddress(spec.asset, METADATA_KEYS.nodeId),
  };
  const binding = await signNodeBinding(spec.node, spec.asset, spec.owner);
  chain.set(addresses.agent, {
    owner: PROGRAMS.registry,
    data: agentAccountBytes({
      collection: spec.collection ?? DEVNET_REGISTRY.collection,
      creator: spec.owner,
      owner: spec.owner,
      asset: spec.asset,
      uri: 'https://gyblos.com/n.json',
    }),
  });
  chain.set(addresses.core, {
    owner: PROGRAMS.mplCore,
    data: coreAssetBytes(spec.owner),
  });
  chain.set(addresses.metadata, {
    owner: PROGRAMS.registry,
    data: metadataBytes(
      spec.asset,
      METADATA_KEYS.nodeId,
      encodeBindingValue(binding),
    ),
  });
  return addresses;
}
