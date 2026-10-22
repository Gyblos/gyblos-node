// Owns the gyblos.nodeId metadata value: a NodeId plus the node key's proof over (program, asset, owner).
// Must not know how metadata is written or fetched; it only encodes, signs and verifies bytes.
import {
  getAddressDecoder,
  getAddressEncoder,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type SignatureBytes,
} from '@solana/kit';

import { ByteReader, concatBytes, utf8 } from './bytes.js';
import { BINDING, IDENTITY_ERROR_CODES, PROGRAMS } from './constants.js';
import { IdentityError } from './errors.js';
import type { DetachedSigner } from './signers.js';

const NODE_ID_HEX = /^[0-9a-f]{64}$/;
const HEX_RADIX = 16;
const ADDRESS_ENCODER = getAddressEncoder();
const ADDRESS_DECODER = getAddressDecoder();

export interface NodeBinding {
  nodeId: string;
  signature: Uint8Array;
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
  return nodeIdFromBytes(new Uint8Array(ADDRESS_ENCODER.encode(nodeAddress)));
}

export function bindingMessage(asset: Address, owner: Address): Uint8Array {
  return concatBytes([
    utf8(BINDING.domain),
    new Uint8Array(ADDRESS_ENCODER.encode(PROGRAMS.registry)),
    new Uint8Array(ADDRESS_ENCODER.encode(asset)),
    new Uint8Array(ADDRESS_ENCODER.encode(owner)),
  ]);
}

export async function signNodeBinding(
  node: DetachedSigner,
  asset: Address,
  owner: Address,
): Promise<NodeBinding> {
  const signature = await node.signDetached(bindingMessage(asset, owner));
  if (signature.length !== BINDING.signatureBytes)
    throw bindingError('node signature must be 64 bytes');
  return { nodeId: nodeIdFromAddress(node.address), signature };
}

export function encodeBindingValue(binding: NodeBinding): Uint8Array {
  if (binding.signature.length !== BINDING.signatureBytes)
    throw bindingError('signature must be 64 bytes');
  return concatBytes([
    Uint8Array.of(BINDING.version),
    nodeIdToBytes(binding.nodeId),
    binding.signature,
  ]);
}

export function decodeBindingValue(value: Uint8Array): NodeBinding {
  if (value.length !== BINDING.valueBytes)
    throw bindingError(`value length ${value.length}`);
  const reader = new ByteReader(value);
  const version = reader.u8();
  if (version !== BINDING.version)
    throw bindingError(`unknown binding version ${version}`);
  const nodeId = nodeIdFromBytes(reader.bytes(BINDING.nodeIdBytes));
  const signature = reader.bytes(BINDING.signatureBytes).slice();
  return { nodeId, signature };
}

function isSignatureBytes(bytes: Uint8Array): bytes is SignatureBytes {
  return bytes.length === BINDING.signatureBytes;
}

export async function verifyNodeBinding(
  binding: NodeBinding,
  asset: Address,
  owner: Address,
): Promise<boolean> {
  if (!isSignatureBytes(binding.signature)) return false;
  const nodeAddress = ADDRESS_DECODER.decode(nodeIdToBytes(binding.nodeId));
  const publicKey = await getPublicKeyFromAddress(nodeAddress);
  return verifySignature(
    publicKey,
    binding.signature,
    bindingMessage(asset, owner),
  );
}
