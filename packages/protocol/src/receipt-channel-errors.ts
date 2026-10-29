// Maps receipt-channel failures to static codes; arbitrary callback/native messages never cross the wire.
import {
  CONTROL_CODES,
  RECEIPT_CHANNEL_CODES,
  type ReceiptChannelCode,
} from './constants';
import { ControlError } from './control-validation';

export class ReceiptChannelError extends Error {
  constructor(
    readonly code: ReceiptChannelCode,
    readonly remote = false,
  ) {
    super(code);
    this.name = 'ReceiptChannelError';
  }
}
export function receiptChannelError(error: unknown): ReceiptChannelError {
  if (error instanceof ReceiptChannelError) return error;
  if (error instanceof ControlError) {
    switch (error.code) {
      case CONTROL_CODES.VERSION:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.VERSION);
      case CONTROL_CODES.POLICY:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
      case CONTROL_CODES.SIGNATURE:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.SIGNATURE);
      case CONTROL_CODES.LIMIT:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.LIMIT);
      case CONTROL_CODES.BUSY:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BUSY);
      case CONTROL_CODES.CANCELLED:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CANCELLED);
      default:
        return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.INVALID);
    }
  }
  return new ReceiptChannelError(RECEIPT_CHANNEL_CODES.INTERNAL);
}
export function receiptChannelBoundary<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw receiptChannelError(error);
  }
}
