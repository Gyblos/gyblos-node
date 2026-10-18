import { createHash } from 'node:crypto';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
// Hash the signed message, independent of base64 spelling or facilitator co-signature.
// Node host utility; never persist the wire transaction itself.
export function exactAuthorizationId(transaction: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  return createHash('sha256').update(Uint8Array.from(tx.messageBytes)).digest('hex');
}
