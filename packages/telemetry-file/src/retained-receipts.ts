// Expiring private receipt bodies with bounded durable replay tombstones; no uploader, service or default home.
import { RECEIPT_COLLECTOR_WRITES } from '@gyblos/core/constants';
import type { PrivateReceiptStore } from '@gyblos/core/receipt-collector';

import { RECEIPT_FILE_CODES, RECEIPT_RETENTION } from './constants';
import {
  receiptFileBoundary,
  receiptFileFail,
  receiptFileSignal,
} from './receipt-store-errors';
import {
  assertReceiptFile,
  openReceiptSnapshot,
  releaseReceiptSnapshot,
  replaceReceiptFile,
} from './receipt-store-io';
import { captureReceipt, verifyStoredReceipt } from './receipt-store-schema';
import type { ReceiptSnapshotState } from './receipt-store-state';
import type { ReceiptFileOptions } from './receipt-store-types';
import {
  parseRetainedReceipts,
  retainedText,
  retentionClock,
  type RetainedReceiptData,
} from './retained-receipt-schema';

export interface RetainedReceiptOptions extends ReceiptFileOptions {
  retentionMs: number;
  now: () => number;
}
export interface RetainedReceiptStore extends PrivateReceiptStore {
  sweep(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
interface RetainedState extends ReceiptSnapshotState {
  data: RetainedReceiptData;
  now: () => number;
  tail: Promise<void>;
  pending: number;
  closed: boolean;
}
async function publish(
  state: RetainedState,
  data: RetainedReceiptData,
  signal?: AbortSignal,
) {
  const text = retainedText(data);
  if (Buffer.byteLength(text) > state.settings.maxBytes) return false;
  await replaceReceiptFile(state, text, signal);
  state.data = data;
  state.text = text;
  return true;
}
async function sweep(state: RetainedState, signal?: AbortSignal) {
  receiptFileSignal(signal);
  if (state.broken) return receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  await assertReceiptFile(state);
  const clock = Math.max(state.data.clock, retentionClock(state.now));
  const entries = state.data.entries.map((row) =>
    row.receipt && row.receivedAt + state.data.retentionMs <= clock
      ? { ...row, receipt: null }
      : row,
  );
  if (entries.some((row, index) => row !== state.data.entries[index])) {
    if (!(await publish(state, { ...state.data, clock, entries }, signal)))
      return receiptFileFail(RECEIPT_FILE_CODES.UNAVAILABLE);
  } else state.data.clock = clock;
}
function lifecycle(state: RetainedState): RetainedReceiptStore {
  let closing: Promise<void> | undefined;
  const queue = async <T>(run: () => Promise<T>, signal?: AbortSignal) => {
    if (state.closed) return receiptFileFail(RECEIPT_FILE_CODES.CLOSED);
    receiptFileSignal(signal);
    if (state.pending >= state.settings.maxPending)
      return receiptFileFail(RECEIPT_FILE_CODES.BUSY);
    state.pending++;
    const result = state.tail.then(() => receiptFileBoundary(run));
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      state.pending--;
    }
  };
  return {
    insert(entry, signal) {
      const pending = captureReceipt(entry);
      return queue(async () => {
        await sweep(state, signal);
        const verified = await verifyStoredReceipt(pending);
        receiptFileSignal(signal);
        const prior = state.data.entries.find(
          (row) => row.key === verified.key,
        );
        if (prior)
          return prior.fingerprint === verified.fingerprint
            ? RECEIPT_COLLECTOR_WRITES.IDENTICAL
            : RECEIPT_COLLECTOR_WRITES.CONFLICT;
        if (state.data.entries.length >= state.settings.maxEntries)
          return RECEIPT_COLLECTOR_WRITES.FULL;
        const data = {
          ...state.data,
          entries: [
            ...state.data.entries,
            { ...verified, receivedAt: state.data.clock },
          ],
        };
        return (await publish(state, data, signal))
          ? RECEIPT_COLLECTOR_WRITES.INSERTED
          : RECEIPT_COLLECTOR_WRITES.FULL;
      }, signal);
    },
    sweep: (signal) => queue(() => sweep(state, signal), signal),
    close() {
      state.closed = true;
      closing ??= receiptFileBoundary(async () => {
        await state.tail;
        await releaseReceiptSnapshot(state);
        state.data.entries = [];
      });
      return closing;
    },
  };
}
async function openRetained(
  options: RetainedReceiptOptions,
  create: boolean,
): Promise<RetainedReceiptStore> {
  if (
    !options ||
    !Number.isSafeInteger(options.retentionMs) ||
    options.retentionMs < 1 ||
    options.retentionMs > RECEIPT_RETENTION.maximumMs ||
    typeof options.now !== 'function'
  )
    return receiptFileFail(RECEIPT_FILE_CODES.INVALID_OPTIONS);
  const initial: RetainedReceiptData = {
    version: RECEIPT_RETENTION.version,
    retentionMs: options.retentionMs,
    clock: retentionClock(options.now),
    entries: [],
  };
  return receiptFileBoundary(async () => {
    const snapshot = await openReceiptSnapshot(
      options,
      create,
      retainedText(initial),
    );
    try {
      const data = await parseRetainedReceipts(
        snapshot.text,
        options.retentionMs,
        snapshot.settings.maxEntries,
        snapshot.settings.maxBytes,
      );
      const state: RetainedState = {
        ...snapshot,
        data,
        now: options.now,
        tail: Promise.resolve(),
        pending: 0,
        closed: false,
      };
      await sweep(state);
      return lifecycle(state);
    } catch (error) {
      await releaseReceiptSnapshot(snapshot);
      throw error;
    }
  });
}
export const createRetainedReceiptStore = (options: RetainedReceiptOptions) =>
  openRetained(options, true);
export const openRetainedReceiptStore = (options: RetainedReceiptOptions) =>
  openRetained(options, false);

export { RECEIPT_RETENTION } from './constants';
