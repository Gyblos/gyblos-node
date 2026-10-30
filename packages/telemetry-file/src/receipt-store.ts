// Exposes explicit create/open lifecycle for private collector storage; nothing starts at import.
import { RECEIPT_FILE_CODES } from './constants';
import { ReceiptFileError } from './receipt-store-errors';
import type {
  ReceiptFileOptions,
  ReceiptFileStore,
} from './receipt-store-types';

export {
  RECEIPT_FILE_CODES,
  RECEIPT_FILE_FORMAT,
  RECEIPT_FILE_LIMITS,
} from './constants';
export { ReceiptFileError } from './receipt-store-errors';
export type {
  ReceiptFileOptions,
  ReceiptFileStore,
} from './receipt-store-types';
export async function createReceiptFileStore(
  _options: ReceiptFileOptions,
): Promise<ReceiptFileStore> {
  throw new ReceiptFileError(RECEIPT_FILE_CODES.UNAVAILABLE);
}
export async function openReceiptFileStore(
  _options: ReceiptFileOptions,
): Promise<ReceiptFileStore> {
  throw new ReceiptFileError(RECEIPT_FILE_CODES.UNAVAILABLE);
}
