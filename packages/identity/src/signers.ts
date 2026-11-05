// Owns the detached Ed25519 signer shape used for off-transaction proofs (node key, payout wallet).
// Must not know which message is signed or where private keys are stored.
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  signBytes,
  type Address,
} from '@solana/kit';

import { BINDING, IDENTITY_ERROR_CODES } from './constants';
import { IdentityError } from './errors';

export interface DetachedSigner {
  readonly address: Address;
  signDetached(message: Uint8Array): Promise<Uint8Array>;
}

export async function detachedSignerFromKeyPair(
  keyPair: CryptoKeyPair,
): Promise<DetachedSigner> {
  const signerAddress = await getAddressFromPublicKey(keyPair.publicKey);
  return {
    address: signerAddress,
    signDetached: async (message) =>
      new Uint8Array(await signBytes(keyPair.privateKey, message)),
  };
}

export async function detachedSignerFromNodeSecret(
  secret: Uint8Array,
): Promise<DetachedSigner> {
  if (!(secret instanceof Uint8Array) || secret.length !== BINDING.nodeIdBytes)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'Invalid node secret.',
    );
  return detachedSignerFromKeyPair(
    await createKeyPairFromPrivateKeyBytes(secret.slice()),
  );
}
