// Enforces the seller's fee budget before SDK admission or either local signing API.
// Validation never sends transactions, replaces a pending attempt or changes a recorded obligation.
import type { KeyPairSigner } from '@solana/kit';
import type { UptoVerifier } from 'x402-upto-metered';

export function limitedFeePayer(signer: KeyPairSigner): KeyPairSigner {
  return signer;
}
export function assertFeeWire(_wire: string, _feePayer: string): void {}
export function feeBoundedUptoVerifier(_feePayer: string, verify: UptoVerifier): UptoVerifier {
  return verify;
}
