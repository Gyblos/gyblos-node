// Owns byte-exact builders for the 8004 instructions Gyblos uses, plus the sponsor prefund transfer.
// Must not know about RPC, fees, simulation or which instructions go together.
import { getTransferSolInstruction } from '@solana-program/system';
import {
  AccountRole,
  getAddressEncoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import {
  concatBytes,
  encodeBool,
  encodeI64,
  encodeString,
  encodeU32,
  encodeVecU8,
  utf8,
} from './bytes.js';
import {
  DEVNET_REGISTRY,
  IDENTITY_ERROR_CODES,
  INSTRUCTION_DISCRIMINATORS,
  LIMITS,
  PROGRAMS,
  WALLET_SET_MESSAGE_PREFIX,
} from './constants.js';
import { IdentityError } from './errors.js';
import {
  findAgentAddress,
  findMetadataAddress,
  metadataKeyHash,
} from './pda.js';
import type { DetachedSigner } from './signers.js';

type AccountMetaWithSigner = AccountMeta | AccountSignerMeta;

type RegistryInstruction = Instruction<
  string,
  readonly AccountMetaWithSigner[]
>;

const ADDRESS_ENCODER = getAddressEncoder();
const ED25519_HEADER_BYTES = 16;
const ED25519_PUBKEY_OFFSET = 16;
const ED25519_SIGNATURE_OFFSET = 48;
const ED25519_MESSAGE_OFFSET = 112;
const ED25519_INLINE_INDEX = 0xffff;

function readonlyMeta(address: Address): AccountMetaWithSigner {
  return { address, role: AccountRole.READONLY };
}

function writableMeta(address: Address): AccountMetaWithSigner {
  return { address, role: AccountRole.WRITABLE };
}

function signerMeta(signer: TransactionSigner): AccountMetaWithSigner {
  return { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer };
}

function assertByteLength(label: string, bytes: Uint8Array, max: number): void {
  if (bytes.length > max) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      `${label} is ${bytes.length} bytes, max ${max}`,
    );
  }
}

export function prefundInstruction(
  sponsor: TransactionSigner,
  owner: Address,
  lamports: bigint,
): Instruction {
  return getTransferSolInstruction({
    source: sponsor,
    destination: owner,
    amount: lamports,
  });
}

export async function registerInstruction(
  owner: TransactionSigner,
  asset: TransactionSigner,
  agentUri: string,
): Promise<RegistryInstruction> {
  assertByteLength('agentUri', utf8(agentUri), LIMITS.uriBytes);
  const atomEnabled = false;
  return {
    programAddress: PROGRAMS.registry,
    accounts: [
      readonlyMeta(DEVNET_REGISTRY.rootConfig),
      readonlyMeta(DEVNET_REGISTRY.registryConfig),
      writableMeta(await findAgentAddress(asset.address)),
      signerMeta(asset),
      writableMeta(DEVNET_REGISTRY.collection),
      signerMeta(owner),
      readonlyMeta(PROGRAMS.system),
      readonlyMeta(PROGRAMS.mplCore),
    ],
    data: concatBytes([
      INSTRUCTION_DISCRIMINATORS.registerWithOptions,
      encodeString(agentUri),
      encodeBool(atomEnabled),
    ]),
  };
}

export async function setMetadataInstruction(
  owner: TransactionSigner,
  asset: Address,
  key: string,
  value: Uint8Array,
): Promise<RegistryInstruction> {
  assertByteLength('metadata key', utf8(key), LIMITS.metadataKeyBytes);
  assertByteLength('metadata value', value, LIMITS.metadataValueBytes);
  const immutable = false;
  return {
    programAddress: PROGRAMS.registry,
    accounts: [
      writableMeta(await findMetadataAddress(asset, key)),
      readonlyMeta(await findAgentAddress(asset)),
      readonlyMeta(asset),
      signerMeta(owner),
      readonlyMeta(PROGRAMS.system),
    ],
    data: concatBytes([
      INSTRUCTION_DISCRIMINATORS.setMetadata,
      await metadataKeyHash(key),
      encodeString(key),
      encodeVecU8(value),
      encodeBool(immutable),
    ]),
  };
}

function walletSetMessage(
  asset: Address,
  wallet: Address,
  owner: Address,
  deadline: bigint,
): Uint8Array {
  return concatBytes([
    utf8(WALLET_SET_MESSAGE_PREFIX),
    new Uint8Array(ADDRESS_ENCODER.encode(asset)),
    new Uint8Array(ADDRESS_ENCODER.encode(wallet)),
    new Uint8Array(ADDRESS_ENCODER.encode(owner)),
    encodeI64(deadline),
  ]);
}

function u16(value: number): Uint8Array {
  return encodeU32(value).subarray(0, 2);
}

function ed25519VerifyInstruction(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Instruction {
  const signatureCount = 1;
  const padding = 0;
  const header = concatBytes([
    Uint8Array.of(signatureCount, padding),
    u16(ED25519_SIGNATURE_OFFSET),
    u16(ED25519_INLINE_INDEX),
    u16(ED25519_PUBKEY_OFFSET),
    u16(ED25519_INLINE_INDEX),
    u16(ED25519_MESSAGE_OFFSET),
    u16(message.length),
    u16(ED25519_INLINE_INDEX),
  ]);
  if (header.length !== ED25519_HEADER_BYTES) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ENCODING_INVARIANT,
      'ed25519 header size drift',
    );
  }
  return {
    programAddress: PROGRAMS.ed25519,
    data: concatBytes([header, publicKey, signature, message]),
  };
}

// Returns [ed25519 proof, set_agent_wallet]; the program requires the proof immediately before.
export async function setAgentWalletInstructions(
  owner: TransactionSigner,
  asset: Address,
  wallet: DetachedSigner,
  deadline: bigint,
): Promise<[Instruction, RegistryInstruction]> {
  const walletBytes = new Uint8Array(ADDRESS_ENCODER.encode(wallet.address));
  const message = walletSetMessage(
    asset,
    wallet.address,
    owner.address,
    deadline,
  );
  const proof = ed25519VerifyInstruction(
    walletBytes,
    await wallet.signDetached(message),
    message,
  );
  const setWallet: RegistryInstruction = {
    programAddress: PROGRAMS.registry,
    accounts: [
      {
        address: owner.address,
        role: AccountRole.READONLY_SIGNER,
        signer: owner,
      },
      writableMeta(await findAgentAddress(asset)),
      readonlyMeta(asset),
      readonlyMeta(PROGRAMS.instructionsSysvar),
    ],
    data: concatBytes([
      INSTRUCTION_DISCRIMINATORS.setAgentWallet,
      walletBytes,
      encodeI64(deadline),
    ]),
  };
  return [proof, setWallet];
}
