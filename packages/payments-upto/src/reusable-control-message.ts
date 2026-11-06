// Builds and verifies the exact buyer-authorized channel close message.
// No network request or signature is performed here.
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getBase58Encoder,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type TransactionPartialSigner,
} from '@solana/kit';
import { requestCloseInstruction } from 'x402-upto-metered';

import { atomic } from './reusable-journal-model';

export function closeMessage(
  signer: TransactionPartialSigner,
  channelId: string,
  input: { blockhash: string; lastValidBlockHeight: string },
) {
  const lifetime = {
    blockhash: blockhash(input.blockhash),
    lastValidBlockHeight: BigInt(atomic(input.lastValidBlockHeight)),
  };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(signer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) =>
      appendTransactionMessageInstructions(
        [requestCloseInstruction(signer, channelId)],
        draft,
      ),
  );
  const bytes = Uint8Array.from(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(message),
    ),
  );
  return { message, bytes };
}

export async function verifyCloseSignature(
  signer: Address,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(encoder.encode(signer)),
      'Ed25519',
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      Uint8Array.from(encoder.encode(signature)),
      Uint8Array.from(message),
    );
  } catch {
    return false;
  }
}
