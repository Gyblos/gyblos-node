// Retains exact opening signing intents and verified signatures in the existing private batch store.
// SDK rebuilding may only reuse the same bytes; it never creates a different financial attempt.
import {
  assertIsSignatureBytes,
  getPublicKeyFromAddress,
  verifySignature,
  type SignatureDictionary,
} from '@solana/kit';

import { controlObject } from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchStore } from './batch-session-store';
import type { BatchBuyerOptions } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS, BATCH_OPENING_LIMITS } from './constants';

async function checkpoint(
  payer: BatchBuyerOptions['payer'],
  store: BatchStore,
  key: string,
  bytes: Uint8Array,
  sign: () => Promise<SignatureDictionary | undefined>,
  check: () => void,
  recovering: boolean,
): Promise<SignatureDictionary> {
  if (bytes.length > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  const message = Buffer.from(bytes).toString('base64');
  const saved = store.read().pending[key];
  const previous = saved
    ? controlObject(JSON.parse(saved), ['message', 'signature'])
    : undefined;
  if (!recovering || !previous?.signature) check();
  if (previous && previous.message !== message)
    return sessionFail(SESSION_CODES.BINDING);
  if (!previous)
    await store.pending.set(key, JSON.stringify({ message, signature: null }));
  if (!recovering || !previous?.signature) check();
  const signed = previous?.signature
    ? Uint8Array.from(Buffer.from(String(previous.signature), 'base64'))
    : (await sign())?.[payer.address];
  if (!signed) return sessionFail(SESSION_CODES.UNVERIFIED);
  assertIsSignatureBytes(signed);
  if (
    !(await verifySignature(
      await getPublicKeyFromAddress(payer.address),
      signed,
      bytes,
    ))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  await store.pending.set(
    key,
    JSON.stringify({
      message,
      signature: Buffer.from(signed).toString('base64'),
    }),
  );
  return { [payer.address]: signed };
}

export function batchOpeningSigner(
  payer: BatchBuyerOptions['payer'],
  store: BatchStore,
  check: () => void,
  recovering = false,
): BatchBuyerOptions['payer'] {
  return {
    address: payer.address,
    async signTransactions(...args) {
      const transaction = args[0][0];
      if (args[0].length !== 1 || !transaction)
        return sessionFail(SESSION_CODES.BINDING);
      const bytes = Uint8Array.from(transaction.messageBytes);
      return [
        await checkpoint(
          payer,
          store,
          BATCH_BUYER_CHECKPOINTS.OPENING_TRANSACTION,
          bytes,
          async () => {
            const dictionaries = await payer.signTransactions(...args);
            if (
              dictionaries.length !== 1 ||
              !Buffer.from(transaction.messageBytes).equals(Buffer.from(bytes))
            )
              return sessionFail(SESSION_CODES.BINDING);
            return dictionaries[0];
          },
          check,
          recovering,
        ),
      ];
    },
    async signMessages(...args) {
      const message = args[0][0];
      if (args[0].length !== 1 || !message)
        return sessionFail(SESSION_CODES.BINDING);
      const bytes = Uint8Array.from(message.content);
      return [
        await checkpoint(
          payer,
          store,
          BATCH_BUYER_CHECKPOINTS.OPENING_VOUCHER,
          bytes,
          async () => {
            const dictionaries = await payer.signMessages(...args);
            if (
              dictionaries.length !== 1 ||
              !Buffer.from(message.content).equals(Buffer.from(bytes))
            )
              return sessionFail(SESSION_CODES.BINDING);
            return dictionaries[0];
          },
          check,
          recovering,
        ),
      ];
    },
  };
}
