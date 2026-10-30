// Defines static ingestion errors; external contents and backend details never reach callers.
import {
  RECEIPT_COLLECTOR_CODES,
  type ReceiptCollectorCode,
} from './constants';

export class ReceiptCollectorError extends Error {
  constructor(readonly code: ReceiptCollectorCode) {
    super(code);
    this.name = 'ReceiptCollectorError';
  }
}
export function collectorFail(code: ReceiptCollectorCode): never {
  throw new ReceiptCollectorError(code);
}
export function collectorSignal(signal?: AbortSignal) {
  if (signal?.aborted) collectorFail(RECEIPT_COLLECTOR_CODES.CANCELLED);
}
