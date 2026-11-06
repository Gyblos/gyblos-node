// Verifies a persisted owner-funded registration against its intended identity without signing again.
// Rebuilds the canonical message from the saved proofs, then verifies both transaction signatures.
import {
  address,
  blockhash,
  compileTransaction,
  createNoopSigner,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';

import { decodeBindingValue, nodeIdToBytes } from './binding';
import { ByteReader, bytesEqual } from './bytes';
import {
  ED25519_LAYOUT,
  IDENTITY_ERROR_CODES,
  INSTRUCTION_DISCRIMINATORS,
  LIMITS,
  REGISTRATION_DEFAULTS,
  REGISTRATION_ERROR_LIMITS,
} from './constants';
import { IdentityError } from './errors';
import type { PreparedOwnerRegistration } from './owner-submission';
import { composeMessage, registrationInstructions } from './registration';

type RegistrationMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']
>;
async function restoreMessage(
  message: RegistrationMessage,
  prepared: PreparedOwnerRegistration,
  expected: { owner: string; asset: string; nodeId: string },
) {
  const metadata = new ByteReader(
    Uint8Array.from(message.instructions[1]!.data ?? []),
  );
  metadata.skip(
    INSTRUCTION_DISCRIMINATORS.setMetadata.length + LIMITS.keyHashBytes,
  );
  metadata.string(LIMITS.metadataKeyBytes);
  const binding = decodeBindingValue(metadata.vecU8(LIMITS.metadataValueBytes));
  if (binding.nodeId !== expected.nodeId) throw new Error();
  const walletData = Uint8Array.from(message.instructions[3]!.data ?? []);
  const deadline = new DataView(
    walletData.buffer,
    walletData.byteOffset,
    walletData.byteLength,
  ).getBigInt64(walletData.length - ED25519_LAYOUT.deadlineBytes, true);
  const proof = Uint8Array.from(message.instructions[2]!.data ?? []);
  const walletSignature = proof.slice(
    ED25519_LAYOUT.signatureOffset,
    ED25519_LAYOUT.messageOffset,
  );
  const owner = createNoopSigner(address(expected.owner));
  const asset = createNoopSigner(address(expected.asset));
  const instructions = await registrationInstructions(
    {
      owner,
      asset,
      node: {
        address: getAddressDecoder().decode(nodeIdToBytes(expected.nodeId)),
        signDetached: async () => binding.signature,
      },
      payoutWallet: {
        address: owner.address,
        signDetached: async () => walletSignature,
      },
      agentUri: REGISTRATION_DEFAULTS.agentUri,
      bindingSequence: binding.sequence,
    },
    deadline,
  );
  const rebuilt = compileTransaction(
    composeMessage(
      owner,
      {
        blockhash: blockhash(message.lifetimeToken),
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      },
      instructions.instructions,
    ),
  );
  return { rebuilt, proof, walletSignature, owner };
}

export async function verifyPreparedOwnerRegistration(
  prepared: PreparedOwnerRegistration,
  expected: { owner: string; asset: string; nodeId: string },
): Promise<void> {
  try {
    const wire = Uint8Array.from(getBase64Encoder().encode(prepared.wire));
    if (
      wire.length > LIMITS.transactionBytes ||
      Buffer.from(wire).toString('base64') !== prepared.wire
    )
      throw new Error();
    const transaction = getTransactionDecoder().decode(wire);
    if (getBase64EncodedWireTransaction(transaction) !== prepared.wire)
      throw new Error();
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    if (
      message.version !== 0 ||
      (message.addressTableLookups?.length ?? 0) !== 0 ||
      message.header.numSignerAccounts !== 2 ||
      message.staticAccounts[0] !== expected.owner ||
      message.staticAccounts[1] !== expected.asset ||
      expected.owner === expected.asset ||
      Object.keys(transaction.signatures).length !== 2 ||
      message.instructions.length !==
        Number(REGISTRATION_ERROR_LIMITS.maxInstructionIndex + 1n) ||
      getSignatureFromTransaction(transaction) !== prepared.signature
    )
      throw new Error();
    const { rebuilt, proof, walletSignature, owner } = await restoreMessage(
      message,
      prepared,
      expected,
    );
    const asset = address(expected.asset);
    if (
      !bytesEqual(
        Uint8Array.from(transaction.messageBytes),
        Uint8Array.from(rebuilt.messageBytes),
      )
    )
      throw new Error();
    for (const signer of [owner.address, asset]) {
      const signed = transaction.signatures[signer];
      if (
        !signed ||
        !(await verifySignature(
          await getPublicKeyFromAddress(signer),
          signed,
          transaction.messageBytes,
        ))
      )
        throw new Error();
    }
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        await getPublicKeyFromAddress(owner.address),
        walletSignature,
        proof.slice(ED25519_LAYOUT.messageOffset),
      ))
    )
      throw new Error();
  } catch {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'Saved registration is invalid.',
    );
  }
}
