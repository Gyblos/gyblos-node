// Serializes bounded private collector writes under one exclusive process owner; no startup or uploads.
import {
  RECEIPT_COLLECTOR_WRITES,
  type ReceiptCollectorWrite,
} from '@gyblos/core/constants';
import type { PrivateFreeReceipt } from '@gyblos/core/receipt-collector';

import { RECEIPT_FILE_CODES } from './constants';
import {
  receiptFileBoundary,
  receiptFileFail,
  receiptFileSignal,
} from './receipt-store-errors';
import {
  assertReceiptFile,
  openReceiptState,
  replaceReceiptFile,
} from './receipt-store-io';
import {
  captureReceipt,
  snapshotText,
  verifyStoredReceipt,
  type PendingReceipt,
} from './receipt-store-schema';
import type { ReceiptFileState } from './receipt-store-state';
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

async function insertReceipt(
  state: ReceiptFileState,
  pending: PendingReceipt,
  signal?: AbortSignal,
): Promise<ReceiptCollectorWrite> {
  receiptFileSignal(signal);
  if (state.broken) return receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  await assertReceiptFile(state);
  const entry = await verifyStoredReceipt(pending);
  receiptFileSignal(signal);
  const previous = state.entries.find((value) => value.key === entry.key);
  if (previous)
    return previous.fingerprint === entry.fingerprint
      ? RECEIPT_COLLECTOR_WRITES.IDENTICAL
      : RECEIPT_COLLECTOR_WRITES.CONFLICT;
  if (state.entries.length >= state.settings.maxEntries)
    return RECEIPT_COLLECTOR_WRITES.FULL;
  const entries = [...state.entries, entry];
  const text = snapshotText(entries);
  if (Buffer.byteLength(text) > state.settings.maxBytes)
    return RECEIPT_COLLECTOR_WRITES.FULL;
  await replaceReceiptFile(state, text, signal);
  state.entries = entries;
  state.text = text;
  receiptFileSignal(signal);
  return RECEIPT_COLLECTOR_WRITES.INSERTED;
}
function lifecycle(state: ReceiptFileState): ReceiptFileStore {
  let closing: Promise<void> | undefined;
  return {
    async insert(entry: PrivateFreeReceipt, signal?: AbortSignal) {
      if (state.closed) return receiptFileFail(RECEIPT_FILE_CODES.CLOSED);
      receiptFileSignal(signal);
      if (state.pending >= state.settings.maxPending)
        return receiptFileFail(RECEIPT_FILE_CODES.BUSY);
      const pending = captureReceipt(entry);
      state.pending++;
      const result = state.tail.then(() =>
        receiptFileBoundary(() => insertReceipt(state, pending, signal)),
      );
      state.tail = result.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await result;
      } finally {
        state.pending--;
      }
    },
    close() {
      state.closed = true;
      closing ??= receiptFileBoundary(async () => {
        await state.tail;
        try {
          await state.lock.release();
        } finally {
          await state.parent.close();
          state.entries = [];
        }
      });
      return closing;
    },
  };
}
export async function createReceiptFileStore(
  options: ReceiptFileOptions,
): Promise<ReceiptFileStore> {
  return lifecycle(await openReceiptState(options, true));
}
export async function openReceiptFileStore(
  options: ReceiptFileOptions,
): Promise<ReceiptFileStore> {
  return lifecycle(await openReceiptState(options, false));
}
