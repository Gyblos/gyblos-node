// Sending the package's own transactions: each RPC call under its own deadline, one transaction
// signed and paid by its fee payer, and its confirmation polled for a bounded time. Shared by the
// payer's withdrawal and the seller's recipient token accounts.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Instruction,
  type Signature,
  type TransactionSigner,
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
  getSignatureStatuses(signatures: Signature[]): UptoCall<{
    value: readonly ({
      err: unknown;
      confirmationStatus: Landed | 'processed' | null;
    } | null)[];
  }>;
}

export const uptoConfirmed: UptoConfirmed = { commitment: UPTO_COMMITMENT };
export const uptoPause = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

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
  sleep: (ms: number) => Promise<void> = uptoPause,
): Promise<{ transaction: string; confirmed: boolean }> {
  const { value: lifetime } = await uptoRead(
    rpc.getLatestBlockhash(uptoConfirmed),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(feePayer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const signed = await signTransactionMessageWithSigners(message);
  let signature: Signature;
  try {
    signature = await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: UPTO_COMMITMENT,
      })
      .send({ abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs) });
  } catch (error) {
    throw new UptoError(
      isSolanaError(
        error,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
        ? UPTO_ERROR_CODES.CHAIN_REJECTED
        : UPTO_ERROR_CODES.UNAVAILABLE,
    );
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
