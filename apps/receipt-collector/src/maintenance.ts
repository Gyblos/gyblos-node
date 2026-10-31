// Sweep congestion is transient; storage or integrity failures must still close receiver admission.
import {
  RECEIPT_FILE_CODES,
  ReceiptFileError,
} from '@gyblos/telemetry-file/receipt-store';
import type { RetainedReceiptStore } from '@gyblos/telemetry-file/retained-receipts';

export async function maintainCollector(
  store: Pick<RetainedReceiptStore, 'sweep'>,
) {
  try {
    await store.sweep();
  } catch (error) {
    if (
      error instanceof ReceiptFileError &&
      error.code === RECEIPT_FILE_CODES.BUSY
    )
      return;
    throw error;
  }
}
