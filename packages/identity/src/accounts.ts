// Owns decoding and validation of 8004 AgentAccount, MetadataEntryPda and Core AssetV1 owner.
// Must not know how accounts are fetched or what Gyblos stores inside metadata values.
import { getAddressDecoder, type Address } from '@solana/kit';

import { ByteReader, bytesEqual } from './bytes';
import {
  ACCOUNT_DISCRIMINATORS,
  IDENTITY_ERROR_CODES,
  LIMITS,
  MPL_CORE_ASSET_V1_KEY,
} from './constants';
import { IdentityError } from './errors';

const ADDRESS_BYTES = 32;
const DIGEST_BYTES = 32;
const U64_BYTES = 8;
const NFT_NAME_BYTES = 32;
const COLLECTION_POINTER_BYTES = 128;
const ADDRESS_DECODER = getAddressDecoder();

export interface AgentAccount {
  collection: Address;
  creator: Address;
  owner: Address;
  asset: Address;
  atomEnabled: boolean;
  agentWallet: Address | undefined;
  parentAsset: Address | undefined;
  agentUri: string;
  nftName: string;
}

export interface MetadataEntry {
  asset: Address;
  immutable: boolean;
  key: string;
  value: Uint8Array;
}

function readAddress(reader: ByteReader): Address {
  return ADDRESS_DECODER.decode(reader.bytes(ADDRESS_BYTES));
}

function expectDiscriminator(
  reader: ByteReader,
  expected: Uint8Array,
  label: string,
): void {
  if (!bytesEqual(reader.bytes(expected.length), expected)) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
      `${label}: wrong account discriminator`,
    );
  }
}

function skipReputationDigests(reader: ByteReader): void {
  // feedback, response and revoke: each a 32-byte digest plus a u64 count.
  const digestCount = 3;
  for (let index = 0; index < digestCount; index += 1) {
    reader.skip(DIGEST_BYTES + U64_BYTES);
  }
}

export function decodeAgentAccount(data: Uint8Array): AgentAccount {
  const reader = new ByteReader(data);
  expectDiscriminator(reader, ACCOUNT_DISCRIMINATORS.agent, 'AgentAccount');
  const collection = readAddress(reader);
  const creator = readAddress(reader);
  const owner = readAddress(reader);
  const asset = readAddress(reader);
  reader.skip(1); // bump
  const atomEnabled = reader.bool();
  const agentWallet = reader.option(() => readAddress(reader));
  skipReputationDigests(reader);
  const parentAsset = reader.option(() => readAddress(reader));
  reader.bool(); // parent_locked
  reader.bool(); // col_locked
  const agentUri = reader.string(LIMITS.uriBytes);
  const nftName = reader.string(NFT_NAME_BYTES);
  reader.string(COLLECTION_POINTER_BYTES); // col pointer, validated but unused
  return {
    collection,
    creator,
    owner,
    asset,
    atomEnabled,
    agentWallet,
    parentAsset,
    agentUri,
    nftName,
  };
}

export function decodeMetadataEntry(data: Uint8Array): MetadataEntry {
  const reader = new ByteReader(data);
  expectDiscriminator(
    reader,
    ACCOUNT_DISCRIMINATORS.metadata,
    'MetadataEntryPda',
  );
  const asset = readAddress(reader);
  const immutable = reader.bool();
  reader.skip(1); // bump
  const key = reader.string(LIMITS.metadataKeyBytes);
  const value = reader.vecU8(LIMITS.metadataValueBytes).slice();
  return { asset, immutable, key, value };
}

export function decodeCoreAssetOwner(data: Uint8Array): Address {
  const reader = new ByteReader(data);
  const key = reader.u8();
  if (key !== MPL_CORE_ASSET_V1_KEY) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
      `Core asset: key ${key} is not AssetV1`,
    );
  }
  return readAddress(reader);
}
