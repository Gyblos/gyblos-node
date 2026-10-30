// Keeps storage failures static and content-free; filenames and system errors never escape.
import { RECEIPT_FILE_CODES, type ReceiptFileCode } from './constants';

export class ReceiptFileError extends Error {
  constructor(readonly code: ReceiptFileCode) {
    super(code);
    this.name = 'ReceiptFileError';
  }
}
export function receiptFileFail(code: ReceiptFileCode): never {
  throw new ReceiptFileError(code);
}
export function receiptFileSignal(signal?: AbortSignal) {
  if (signal?.aborted) receiptFileFail(RECEIPT_FILE_CODES.CANCELLED);
}
