// Strict scalar and object validation for the private reusable-channel journal.
import { isAddress } from '@solana/kit';

import {
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

export function unavailable(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fields(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
export function address(value: unknown): string {
  return typeof value === 'string' && isAddress(value) ? value : unavailable();
}
export function digest(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? value
    : unavailable();
}
export function atomic(value: unknown): string {
  return typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
    ? value
    : unavailable();
}
