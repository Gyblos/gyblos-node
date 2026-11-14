// Rebuilds buyer control messages from frozen channel terms; private checkpoint bytes confer no authority.
import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';
import {
  distributeInstruction,
  payerTokenAccountInstruction,
  requestCloseInstruction,
  sealInstruction,
  type UptoWithdrawalAttempt,
} from 'x402-upto-metered';

import { paymentSplits } from '@gyblos/protocol/payment-binding';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchBuyerOptions, BatchRecord } from './batch-session-types';
import { BATCH_OPENING_LIMITS, WITHDRAW_STEPS } from './constants';

export interface BatchControlIntent {
  step: UptoWithdrawalAttempt['step'];
  wire: string;
  lastValidBlockHeight: string;
  checkedSlot: string;
}

async function expectedMessage(
  record: BatchRecord,
  payer: BatchBuyerOptions['payer'],
  intent: BatchControlIntent,
  includeSeal: boolean,
) {
  const transaction = decodeControlWire(intent.wire);
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  const terms = record.terms;
  const instructions =
    intent.step === WITHDRAW_STEPS.CLOSE_REQUESTED
      ? [requestCloseInstruction(payer, record.channelId)]
      : [
          await payerTokenAccountInstruction(
            payer,
            terms.mint,
            TOKEN_PROGRAM_ADDRESS,
          ),
          ...(includeSeal ? [sealInstruction(record.channelId)] : []),
          await distributeInstruction({
            channelId: record.channelId,
            payer: terms.buyer,
            payee: terms.feePayer,
            rentPayer: terms.feePayer,
            mint: terms.mint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
            network: terms.network,
            splits: paymentSplits(terms),
          }),
        ];
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayerSigner(payer, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(message.lifetimeToken),
            lastValidBlockHeight: BigInt(intent.lastValidBlockHeight),
          },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions(instructions, draft),
    ),
  ).messageBytes;
}
export function decodeControlWire(wire: string) {
  if (!wire || wire.length > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  const bytes = Buffer.from(wire, 'base64');
  if (bytes.toString('base64') !== wire)
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const transaction = getTransactionDecoder().decode(bytes);
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}
export async function validateControlIntent(
  record: BatchRecord,
  payer: BatchBuyerOptions['payer'],
  intent: BatchControlIntent,
) {
  const actual = decodeControlWire(intent.wire).messageBytes;
  const matches = async (seal: boolean) =>
    Buffer.from(actual).equals(
      Buffer.from(await expectedMessage(record, payer, intent, seal)),
    );
  if (!(await matches(false)) && !(await matches(true)))
    return sessionFail(SESSION_CODES.BINDING);
}
export async function validateControlSignature(
  payer: BatchBuyerOptions['payer'],
  attempt: UptoWithdrawalAttempt,
  wire: string,
) {
  const transaction = decodeControlWire(wire);
  assertIsFullySignedTransaction(transaction);
  const signed = transaction.signatures[payer.address];
  if (
    String(getSignatureFromTransaction(transaction)) !== attempt.transaction ||
    !signed ||
    !(await verifySignature(
      await getPublicKeyFromAddress(payer.address),
      signed,
      transaction.messageBytes,
    ))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
}
