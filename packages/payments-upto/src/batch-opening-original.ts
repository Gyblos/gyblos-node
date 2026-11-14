// Reconstructs only original SDK bytes, using no wallet authority; temporary placeholder payloads never escape.
import {
  address,
  assertIsSignatureBytes,
  createNoopSigner,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';

import { canonicalJson } from '@gyblos/protocol';
import { controlObject } from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { buildBuyerOpening } from './batch-opening-build';
import { openingMessage } from './batch-opening-proof';
import type { BatchRecord } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS, BATCH_OPENING_LIMITS } from './constants';

export async function originalBatchOpening(record: BatchRecord) {
  const original = openingMessage(record);
  if (original.length > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  // The SDK has no public unsigned batch builder. Noop signs no transaction; this zero placeholder
  // merely lets its zero-voucher construction finish. Neither voucher nor payload is returned or saved.
  const placeholder = new Uint8Array(BATCH_OPENING_LIMITS.signatureBytes);
  assertIsSignatureBytes(placeholder);
  const built = await buildBuyerOpening(record, {
    ...createNoopSigner(address(record.terms.buyer)),
    signMessages: async () => [{ [record.terms.buyer]: placeholder }],
  });
  const expected = getTransactionDecoder().decode(
    Buffer.from(built.payload.deposit.transaction, 'base64'),
  ).messageBytes;
  if (
    !Buffer.from(original).equals(Buffer.from(expected)) ||
    (record.channelId !== '' && record.channelId !== built.channelId) ||
    (record.opening &&
      canonicalJson(record.opening.channelConfig) !==
        canonicalJson(built.payload.channelConfig))
  )
    return sessionFail(SESSION_CODES.BINDING);
  let signed;
  if (record.opening)
    signed = getTransactionDecoder().decode(
      Buffer.from(record.opening.deposit.transaction, 'base64'),
    ).signatures[address(record.terms.buyer)];
  else {
    const row = controlObject(
      JSON.parse(record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_TRANSACTION]!),
      ['message', 'signature'],
    );
    if (row.signature !== null) {
      if (typeof row.signature !== 'string')
        return sessionFail(SESSION_CODES.UNVERIFIED);
      const bytes = Buffer.from(row.signature, 'base64');
      if (bytes.toString('base64') !== row.signature)
        return sessionFail(SESSION_CODES.UNVERIFIED);
      const signature = Uint8Array.from(bytes);
      assertIsSignatureBytes(signature);
      signed = signature;
    }
  }
  if (
    signed &&
    !(await verifySignature(
      await getPublicKeyFromAddress(address(record.terms.buyer)),
      signed,
      original,
    ))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (record.opening && !signed) return sessionFail(SESSION_CODES.UNVERIFIED);
  return { channelId: built.channelId, message: original };
}
