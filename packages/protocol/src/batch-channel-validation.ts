// Static session boundary errors and bounded financial shapes; never reflect untrusted contents.
import type { BatchChannelCode } from './batch-channel-types';
import { CONTROL_CODES } from './constants';
import {
  controlAddress,
  controlAtomic,
  ControlError,
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import { INFERENCE_CODES, InferenceError } from './inference';
import { PAID_EXECUTION_CODES } from './paid/constants';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  type SessionBill,
  type SessionSnapshot,
  type SessionVoucher,
} from './payment-session';

export class BatchChannelError extends Error {
  constructor(
    readonly code: BatchChannelCode,
    readonly remote = false,
  ) {
    super(code);
    this.name = 'BatchChannelError';
  }
}
export function batchFail(
  code: BatchChannelCode = SESSION_CODES.INVALID,
): never {
  throw new BatchChannelError(code);
}
export function batchError(error: unknown): BatchChannelError {
  if (error instanceof InferenceError)
    return new BatchChannelError(
      error.code === INFERENCE_CODES.LIMIT
        ? PAID_EXECUTION_CODES.LIMIT
        : error.code === INFERENCE_CODES.UNSUPPORTED
          ? PAID_EXECUTION_CODES.UNSUPPORTED
          : PAID_EXECUTION_CODES.INTERNAL,
    );
  if (error instanceof BatchChannelError) return error;
  if (error instanceof ControlError) {
    if (error.code === CONTROL_CODES.LIMIT)
      return new BatchChannelError(SESSION_CODES.LIMIT);
    if (error.code === CONTROL_CODES.EXPIRED)
      return new BatchChannelError(PAID_EXECUTION_CODES.EXPIRED);
    if (error.code === CONTROL_CODES.SIGNATURE)
      return new BatchChannelError(PAID_EXECUTION_CODES.SIGNATURE);
    return new BatchChannelError(SESSION_CODES.INVALID);
  }
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  const known = [
    ...Object.values(SESSION_CODES),
    ...Object.values(PAID_EXECUTION_CODES),
  ].find((value) => value === code);
  return new BatchChannelError(known ?? PAID_EXECUTION_CODES.INTERNAL);
}
export function batchBoundary<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof BatchChannelError) throw error;
    if (error instanceof ControlError) throw batchError(error);
    return batchFail();
  }
}
export function batchBill(value: unknown): SessionBill {
  const row = controlObject(value, [
    'requestId',
    'requestDigest',
    'maxAtomic',
    'chargedAtomic',
    'cumulativeAtomic',
  ]);
  const bill = {
    requestId: controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes),
    requestDigest: controlHex(row.requestDigest, PAYMENT_SESSION.digestBytes),
    maxAtomic: controlAtomic(row.maxAtomic),
    chargedAtomic: controlAtomic(row.chargedAtomic),
    cumulativeAtomic: controlAtomic(row.cumulativeAtomic),
  };
  if (
    BigInt(bill.chargedAtomic) > BigInt(bill.maxAtomic) ||
    BigInt(bill.chargedAtomic) > BigInt(bill.cumulativeAtomic)
  )
    return batchFail(SESSION_CODES.LIMIT);
  return bill;
}
export function batchVoucher(value: unknown): SessionVoucher {
  const row = controlObject(value, [
    'channelId',
    'maxClaimableAmount',
    'expiresAt',
    'signature',
  ]);
  if (
    row.expiresAt !== PAYMENT_SESSION.voucherExpiry ||
    typeof row.signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.signature)
  )
    return batchFail();
  return {
    channelId: controlAddress(row.channelId),
    maxClaimableAmount: controlAtomic(row.maxClaimableAmount),
    expiresAt: row.expiresAt,
    signature: row.signature,
  };
}
export function batchSnapshot(value: unknown): SessionSnapshot {
  const row = controlObject(value, [
    'expiresAt',
    'channelId',
    'state',
    'cumulativeAtomic',
    'reservedAtomic',
  ]);
  const state = Object.values(SESSION_STATES).find(
    (known) => known === row.state,
  );
  if (!state) return batchFail();
  return {
    expiresAt: controlInteger(row.expiresAt, 1),
    channelId: controlAddress(row.channelId),
    state,
    cumulativeAtomic: controlAtomic(row.cumulativeAtomic),
    reservedAtomic: controlAtomic(row.reservedAtomic),
  };
}
