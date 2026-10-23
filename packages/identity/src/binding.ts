// Owns the gyblos.nodeId metadata value: a NodeId, a rebinding sequence and the node key's proof over
// (version, sequence, program, asset, owner). Must not know how metadata is written or fetched; bytes only.
import {
  getAddressDecoder,
  getAddressEncoder,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type SignatureBytes,
} from '@solana/kit';

import {
  ByteReader,
  concatBytes,
  encodeString,
  encodeU32,
  encodeU64,
  utf8,
} from './bytes.js';
import {
  BINDING,
  BINDING_LAYOUTS,
  BINDING_VERSIONS,
  IDENTITY_ERROR_CODES,
  METADATA_KEYS,
  PROGRAMS,
  type BindingVersion,
} from './constants.js';
import { IdentityError } from './errors.js';
import type { DetachedSigner } from './signers.js';

const NODE_ID_HEX = /^[0-9a-f]{64}$/;
const HEX_RADIX = 16;
const ADDRESS_ENCODER = getAddressEncoder();
const ADDRESS_DECODER = getAddressDecoder();

export interface NodeBinding {
  version: BindingVersion;
  nodeId: string;
  // Higher wins when several valid claims name one NodeId; legacy v1 values read as 0.
  sequence: bigint;
  signature: Uint8Array;
}

// What the node key vouches for. Callers pick a strictly increasing sequence per node key
// (for example unix milliseconds, or a counter persisted next to the key) so a rebinding outranks older ones.
export interface BindingClaim {
  asset: Address;
  owner: Address;
  sequence: bigint;
}

function bindingError(message: string): IdentityError {
  return new IdentityError(IDENTITY_ERROR_CODES.BINDING_INVALID, message);
}

// Canonical NodeId text: 64 lowercase hex characters, as iroh's EndpointId prints itself.
export function isCanonicalNodeId(nodeId: string): boolean {
  return NODE_ID_HEX.test(nodeId);
}

export function nodeIdToBytes(nodeId: string): Uint8Array {
  if (!isCanonicalNodeId(nodeId)) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'nodeId must be 64 lowercase hex characters',
    );
  }
  return Uint8Array.from(nodeId.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, HEX_RADIX),
  );
}

export function nodeIdFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(2, '0'),
  ).join('');
}

export function nodeIdFromAddress(nodeAddress: Address): string {
  return nodeIdFromBytes(addressBytes(nodeAddress));
}

function addressBytes(value: Address): Uint8Array {
  return new Uint8Array(ADDRESS_ENCODER.encode(value));
}

function isBindingVersion(version: number): version is BindingVersion {
  return version === BINDING_VERSIONS.V1 || version === BINDING_VERSIONS.V2;
}

function assertSequence(sequence: bigint): void {
  if (sequence < 0n || sequence > BINDING.maxSequence) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'binding sequence must fit in a u64',
    );
  }
}

// v2 signs the version and sequence too, so neither can be changed without the node key.
export function bindingMessage(
  version: BindingVersion,
  claim: BindingClaim,
): Uint8Array {
  const signed =
    version === BINDING_VERSIONS.V1
      ? []
      : [Uint8Array.of(version), encodeU64(claim.sequence)];
  return concatBytes([
    utf8(BINDING_LAYOUTS[version].domain),
    ...signed,
    addressBytes(PROGRAMS.registry),
    addressBytes(claim.asset),
    addressBytes(claim.owner),
  ]);
}

export async function signNodeBinding(
  node: DetachedSigner,
  claim: BindingClaim,
): Promise<NodeBinding> {
  assertSequence(claim.sequence);
  const signature = await node.signDetached(
    bindingMessage(BINDING.version, claim),
  );
  if (signature.length !== BINDING.signatureBytes)
    throw bindingError('node signature must be 64 bytes');
  return {
    version: BINDING.version,
    nodeId: nodeIdFromAddress(node.address),
    sequence: claim.sequence,
    signature,
  };
}

// Only the current version is written; legacy v1 values are accepted by decodeBindingValue alone.
export function encodeBindingValue(binding: NodeBinding): Uint8Array {
  if (binding.version !== BINDING.version)
    throw bindingError(`cannot write binding version ${binding.version}`);
  if (binding.signature.length !== BINDING.signatureBytes)
    throw bindingError('signature must be 64 bytes');
  assertSequence(binding.sequence);
  return concatBytes([
    Uint8Array.of(binding.version),
    nodeIdToBytes(binding.nodeId),
    encodeU64(binding.sequence),
    binding.signature,
  ]);
}

export function decodeBindingValue(value: Uint8Array): NodeBinding {
  if (value.length === 0) throw bindingError('empty binding value');
  const reader = new ByteReader(value);
  const version = reader.u8();
  if (!isBindingVersion(version))
    throw bindingError(`unknown binding version ${version}`);
  if (value.length !== BINDING_LAYOUTS[version].valueBytes)
    throw bindingError(`v${version} value length ${value.length}`);
  const nodeId = nodeIdFromBytes(reader.bytes(BINDING.nodeIdBytes));
  const sequence =
    version === BINDING_VERSIONS.V1 ? BINDING.legacySequence : reader.u64();
  const signature = reader.bytes(BINDING.signatureBytes).slice();
  return { version, nodeId, sequence, signature };
}

// getProgramAccounts prefix at the metadata key offset: key ‖ value length ‖ version ‖ nodeId.
export function nodeIdMetadataPrefix(
  nodeId: string,
  version: BindingVersion,
): Uint8Array {
  return concatBytes([
    encodeString(METADATA_KEYS.nodeId),
    encodeU32(BINDING_LAYOUTS[version].valueBytes),
    Uint8Array.of(version),
    nodeIdToBytes(nodeId),
  ]);
}

function isSignatureBytes(bytes: Uint8Array): bytes is SignatureBytes {
  return bytes.length === BINDING.signatureBytes;
}

// Verifies an Ed25519 signature by the key a canonical NodeId names.
export async function verifyNodeSignature(
  nodeId: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (!isSignatureBytes(signature)) return false;
  const nodeAddress = ADDRESS_DECODER.decode(nodeIdToBytes(nodeId));
  const publicKey = await getPublicKeyFromAddress(nodeAddress);
  return verifySignature(publicKey, signature, message);
}

export function verifyNodeBinding(
  binding: NodeBinding,
  asset: Address,
  owner: Address,
): Promise<boolean> {
  return verifyNodeSignature(
    binding.nodeId,
    bindingMessage(binding.version, {
      asset,
      owner,
      sequence: binding.sequence,
    }),
    binding.signature,
  );
}
