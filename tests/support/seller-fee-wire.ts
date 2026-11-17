// Re-signs a synthetic SDK opening after removing only its optional compute limit.
// Demonstrates the SDK/product policy boundary without a seller signature, RPC or broadcast.
import {
  assertIsTransactionWithinSizeLimit,
  blockhash,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from '@solana/kit';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@x402/svm';
import {
  decodeUptoPayload,
  type UptoAuthorization,
  type UptoClientHints,
} from 'x402-upto-metered';

export async function openingWithoutComputeLimit(
  authorization: UptoAuthorization,
  payer: KeyPairSigner,
  hints: UptoClientHints,
): Promise<UptoAuthorization> {
  const payload = decodeUptoPayload(authorization);
  if (typeof payload.openTransaction !== 'string')
    throw new Error('Expected synthetic opening');
  const original = getTransactionDecoder().decode(
    Buffer.from(payload.openTransaction, 'base64'),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    original.messageBytes,
  );
  if (message.version !== 0) throw new Error('Expected synthetic v0 opening');
  const bytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    instructions: message.instructions.filter(
      (instruction) =>
        message.staticAccounts[instruction.programAddressIndex] !==
          COMPUTE_BUDGET_PROGRAM_ADDRESS || instruction.data?.[0] !== 2,
    ),
  });
  const wire = Buffer.concat([
    Buffer.from([message.header.numSignerAccounts]),
    Buffer.alloc(message.header.numSignerAccounts * 64),
    Buffer.from(bytes),
  ]);
  const transaction = {
    ...getTransactionDecoder().decode(wire),
    lifetimeConstraint: {
      blockhash: blockhash(hints.recentBlockhash),
      lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
    },
  };
  assertIsTransactionWithinSizeLimit(transaction);
  const signed = await payer.signTransactions([transaction]);
  if (!signed[0]) throw new Error('Expected synthetic signature');
  const openTransaction = getBase64EncodedWireTransaction({
    ...transaction,
    signatures: { ...transaction.signatures, ...signed[0] },
  });
  return {
    ...authorization,
    payload: Buffer.from(
      JSON.stringify({ ...payload, openTransaction }),
    ).toString('base64'),
  };
}
