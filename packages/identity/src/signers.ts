// Owns the detached Ed25519 signer shape used for off-transaction proofs (node key, payout wallet).
// Must not know which message is signed or where private keys are stored.
import { getAddressFromPublicKey, signBytes, type Address } from '@solana/kit';

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
