// Builds an SDK channel open offline; an optional durable checkpoint precedes the real signature.
// Recovery tracks this one opening, never builds a second channel or broadcasts from here.
import {
  assertIsTransactionWithinSizeLimit,
  blockhash,
  createNoopSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isTransactionPartialSigner,
  verifySignature,
  type TransactionPartialSigner,
  type TransactionSigner,
} from '@solana/kit';
import { UptoSvmScheme as UptoClientScheme } from '@x402/svm/upto/client';

import { UPTO, UPTO_CLAIM_LIMITS, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import { uptoRequirements } from './requirements';
import type {
  UptoAuthorization,
  UptoClientHints,
  UptoPayloadFields,
  UptoTerms,
} from './types';

// The SDK validates this payload expiry; it is not part of the payer-signed open transaction.
export function uptoClaimUntil(
  authorization: Pick<UptoAuthorization, 'payload'>,
): number {
  const expiresAt = decodeUptoPayload(authorization).expiresAt;
  const cutoff =
    typeof expiresAt === 'number'
      ? expiresAt * UPTO_CLAIM_LIMITS.millisecondsPerSecond
      : Number.NaN;
  if (
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(cutoff) ||
    cutoff <= 0
  )
    throw new UptoError(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
  return cutoff;
}

function isPayload(
  value: unknown,
): value is Record<string, unknown> & UptoPayloadFields {
  return (
    !!value &&
    typeof value === 'object' &&
    'channelId' in value &&
    'from' in value &&
    'maxAmount' in value &&
    'openSlot' in value &&
    typeof value.channelId === 'string' &&
    typeof value.from === 'string' &&
    typeof value.maxAmount === 'string' &&
    typeof value.openSlot === 'string' &&
    /^[0-9]+$/.test(value.openSlot)
  );
}

type OpeningCheckpoint = {
  channelId: string;
  openSlot: string;
  lastValidBlockHeight: string;
};
type BeforeSign = (opening: OpeningCheckpoint) => Promise<void>;

async function signPrepared(
  payer: TransactionPartialSigner,
  payload: Record<string, unknown> & UptoPayloadFields,
  hints: UptoClientHints,
  beforeSign: BeforeSign,
): Promise<string> {
  if (typeof payload.openTransaction !== 'string')
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  const original = payload.openTransaction;
  const decode = () =>
    getTransactionDecoder().decode(Buffer.from(original, 'base64'));
  const transaction = decode();
  const expected = Buffer.from(transaction.messageBytes);
  if (
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
      .lifetimeToken !== hints.recentBlockhash ||
    payload.openSlot !== hints.recentSlot
  )
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  const request = {
    ...transaction,
    lifetimeConstraint: {
      blockhash: blockhash(hints.recentBlockhash),
      lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
    },
  };
  assertIsTransactionWithinSizeLimit(request);
  await beforeSign({
    channelId: payload.channelId,
    openSlot: payload.openSlot,
    lastValidBlockHeight: hints.lastValidBlockHeight,
  });
  const dictionaries = await payer.signTransactions([request]);
  const signature = dictionaries[0]?.[payer.address];
  if (
    dictionaries.length !== 1 ||
    !signature ||
    !Buffer.from(request.messageBytes).equals(expected)
  )
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  // Encode from fresh original bytes; neither a mutable wallet input nor signature aliases escape.
  const wire = getBase64EncodedWireTransaction({
    ...decode(),
    signatures: { ...decode().signatures, [payer.address]: signature },
  });
  const signed = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const checked = signed.signatures[payer.address];
  if (
    !checked ||
    !(await verifySignature(
      await getPublicKeyFromAddress(payer.address),
      checked,
      signed.messageBytes,
    ))
  )
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  return wire;
}

export async function createUptoAuthorization(
  payer: TransactionSigner,
  terms: UptoTerms,
  hints: UptoClientHints,
  beforeSign?: BeforeSign,
): Promise<UptoAuthorization> {
  // A recoverable open signs only the prepared bytes: sending/modifying signers cannot promise that.
  const partial = isTransactionPartialSigner(payer)
    ? {
        address: payer.address,
        signTransactions: payer.signTransactions.bind(payer),
      }
    : undefined;
  if (beforeSign && !partial)
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  const fixed = { ...hints };
  const requested = {
    ...terms,
    ...(terms.splits
      ? { splits: terms.splits.map((split) => ({ ...split })) }
      : {}),
  };
  const created = await new UptoClientScheme(
    beforeSign ? createNoopSigner(payer.address) : payer,
  ).createPaymentPayload(UPTO.x402Version, uptoRequirements(requested, fixed));
  if (!isPayload(created.payload))
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  const payload = { ...created.payload };
  if (beforeSign && partial)
    payload.openTransaction = await signPrepared(
      partial,
      payload,
      fixed,
      beforeSign,
    );
  return {
    channelId: payload.channelId,
    payer: payload.from,
    maxAtomic: payload.maxAmount,
    payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
  };
}

// The SDK payload inside an authorization, or an AUTHORIZATION_MISMATCH error. Oversized,
// non-canonical base64 or malformed payloads never reach the SDK.
export function decodeUptoPayload(
  authorization: Pick<UptoAuthorization, 'payload'>,
): Record<string, unknown> & UptoPayloadFields {
  try {
    if (authorization.payload.length <= UPTO.payloadBytes) {
      const raw = Buffer.from(authorization.payload, 'base64');
      const decoded: unknown =
        raw.toString('base64') === authorization.payload
          ? JSON.parse(raw.toString('utf8'))
          : undefined;
      if (isPayload(decoded)) return decoded;
    }
  } catch {
    // Falls through to the static mismatch below.
  }
  throw new UptoError(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
}
