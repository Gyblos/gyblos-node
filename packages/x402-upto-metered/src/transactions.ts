// Sending the package's own transactions: each RPC call under its own deadline, one transaction
// signed and paid by its fee payer, and its confirmation polled for a bounded time. Shared by the
// payer's withdrawal and the seller's recipient token accounts, so UPTO_WITHDRAW's rpcMs, pollMs and
// confirmMs bound both.
import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  isTransactionPartialSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Instruction,
  type Signature,
  type Transaction,
  type TransactionSigner,
  type TransactionWithLifetime,
} from '@solana/kit';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_COMMITMENT,
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW,
} from './constants';
import { UptoError, uptoError } from './errors';

export type UptoConfirmed = { commitment: typeof UPTO_COMMITMENT };
type Deadline = { abortSignal: AbortSignal };
export type UptoCall<T> = { send(options: Deadline): Promise<T> };
type Landed = (typeof UPTO_CHANNEL_ACCOUNT.landedStatuses)[number];

// The slice of a @solana/kit RPC that sends and confirms a transaction.
export interface UptoSendRpc {
  getLatestBlockhash(config: UptoConfirmed): UptoCall<{
    value: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  }>;
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: { encoding: 'base64'; preflightCommitment: typeof UPTO_COMMITMENT },
  ): UptoCall<Signature>;
  getSignatureStatuses(
    signatures: Signature[],
    config?: { searchTransactionHistory: true },
  ): UptoCall<{
    context?: { slot: bigint };
    value: readonly ({
      err: unknown;
      confirmationStatus: Landed | 'processed' | null;
      slot?: bigint;
    } | null)[];
  }>;
}

export const uptoConfirmed: UptoConfirmed = { commitment: UPTO_COMMITMENT };
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function signControl(
  payer: TransactionSigner,
  transaction: Transaction & TransactionWithLifetime,
) {
  if (!isTransactionPartialSigner(payer))
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  const expected = Buffer.from(transaction.messageBytes);
  assertIsTransactionWithinSizeLimit(transaction);
  const dictionaries = await payer.signTransactions([transaction]);
  if (
    dictionaries.length !== 1 ||
    !Buffer.from(transaction.messageBytes).equals(expected)
  )
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  const signed = {
    ...transaction,
    signatures: {
      ...transaction.signatures,
      [payer.address]: dictionaries[0]?.[payer.address] ?? null,
    },
  };
  assertIsFullySignedTransaction(signed);
  return signed;
}

// One RPC call under its own deadline; any failure is UNAVAILABLE, never the RPC's own text.
export async function uptoRead<T>(call: UptoCall<T>): Promise<T> {
  try {
    return await call.send({
      abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs),
    });
  } catch {
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

// Waits for the transaction to confirm; a chain error is a refusal, a timeout leaves it unknown.
async function landed(
  rpc: UptoSendRpc,
  sleep: (ms: number) => Promise<void>,
  signature: Signature,
): Promise<boolean> {
  for (let waited = 0; ; waited += UPTO_WITHDRAW.pollMs) {
    const { value } = await uptoRead(rpc.getSignatureStatuses([signature]));
    const status = value[0];
    if (status && status.err !== null)
      throw new UptoError(UPTO_ERROR_CODES.CHAIN_REJECTED);
    if (
      status &&
      UPTO_CHANNEL_ACCOUNT.landedStatuses.some(
        (landedStatus) => landedStatus === status.confirmationStatus,
      )
    )
      return true;
    if (waited >= UPTO_WITHDRAW.confirmMs) return false;
    await sleep(UPTO_WITHDRAW.pollMs);
  }
}

// Signed by the fee payer, who also pays the fee; a preflight refusal costs no fee and is
// CHAIN_REJECTED.
export async function uptoSend(
  rpc: UptoSendRpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
  sleep: (ms: number) => Promise<void> = pause,
  beforeSend?: (attempt: {
    transaction: string;
    lastValidBlockHeight: string;
    wire: string;
  }) => Promise<void>,
  beforeSign?: (intent: {
    wire: string;
    lastValidBlockHeight: string;
  }) => Promise<void>,
): Promise<{ transaction: string; confirmed: boolean }> {
  const { value: lifetime } = await uptoRead(
    rpc.getLatestBlockhash(uptoConfirmed),
  );
  const lastValidBlockHeight = String(lifetime.lastValidBlockHeight);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(feePayer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const unsigned = compileTransaction(message);
  if (beforeSign)
    await beforeSign({
      wire: getBase64EncodedWireTransaction(unsigned),
      lastValidBlockHeight,
    });
  const signed = beforeSend
    ? await signControl(feePayer, unsigned)
    : await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  if (beforeSend) {
    try {
      await beforeSend({
        transaction: String(signature),
        lastValidBlockHeight,
        wire,
      });
    } catch {
      throw new UptoError(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE);
    }
  }
  // The signed bytes already determine the identity, even when the RPC loses its send reply.
  const uncertain = { transaction: String(signature), confirmed: false };
  try {
    const returned = await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        preflightCommitment: UPTO_COMMITMENT,
      })
      .send({ abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs) });
    if (returned !== signature) return uncertain;
  } catch (error) {
    if (
      isSolanaError(
        error,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    )
      throw new UptoError(UPTO_ERROR_CODES.CHAIN_REJECTED);
    return uncertain;
  }
  // Once sent, its signature is kept: a status the RPC could not give leaves it unconfirmed, not lost.
  const unconfirmed = (error: unknown) => {
    if (uptoError(error).code === UPTO_ERROR_CODES.CHAIN_REJECTED) throw error;
    return false;
  };
  return {
    transaction: String(signature),
    confirmed: await landed(rpc, sleep, signature).catch(unconfirmed),
  };
}
