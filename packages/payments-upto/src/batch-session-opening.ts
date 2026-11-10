// Strict SDK opening shape and transaction bounds before private persistence or network work.
import { isBatchPayload, type BatchDepositPayload } from '@x402/svm';

import { canonicalJson } from '@gyblos/protocol';
import {
  controlAddress,
  controlAtomic,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { BATCH_OPENING_LIMITS } from './constants';

function transaction(value: unknown) {
  if (typeof value !== 'string' || !value.length) return sessionFail();
  if (value.length > BATCH_OPENING_LIMITS.transactionBase64Chars)
    return sessionFail(SESSION_CODES.LIMIT);
  const bytes = Buffer.from(value, 'base64');
  if (
    !bytes.length ||
    bytes.length > BATCH_OPENING_LIMITS.transactionBytes ||
    bytes.toString('base64') !== value
  )
    return sessionFail();
}
type ClientOpening = BatchDepositPayload & {
  voucher: NonNullable<BatchDepositPayload['voucher']>;
};
function shape(value: unknown): ClientOpening {
  const row = controlObject(value, [
    'type',
    'channelConfig',
    'deposit',
    'voucher',
  ]);
  const config = controlObject(row.channelConfig, [
    'openSlot',
    'payer',
    'payerAuthorizer',
    'receiver',
    'receiverAuthorizer',
    'salt',
    'token',
    'withdrawDelay',
  ]);
  const deposit = controlObject(row.deposit, ['amount', 'transaction']);
  controlObject(row.voucher, [
    'channelId',
    'expiresAt',
    'maxClaimableAmount',
    'signature',
  ]);
  if (!isBatchPayload(row) || row.type !== 'deposit' || !row.voucher)
    return sessionFail();
  for (const key of [
    'payer',
    'payerAuthorizer',
    'receiver',
    'receiverAuthorizer',
    'token',
  ])
    controlAddress(config[key]);
  controlInteger(config.openSlot, 0);
  controlAtomic(config.salt);
  controlInteger(config.withdrawDelay, 1);
  controlAtomic(deposit.amount);
  transaction(deposit.transaction);
  if (Buffer.byteLength(canonicalJson(row)) > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  return { ...structuredClone(row), voucher: structuredClone(row.voucher) };
}
export function strictBatchOpening(value: unknown): ClientOpening {
  try {
    return shape(value);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === SESSION_CODES.LIMIT
    )
      return sessionFail(SESSION_CODES.LIMIT);
    return sessionFail();
  }
}
