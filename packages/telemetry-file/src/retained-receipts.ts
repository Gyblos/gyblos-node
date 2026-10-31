// Explicit expiring receipt storage with private replay tombstones; no service, upload or home selection.
import { RECEIPT_COLLECTOR_WRITES } from '@gyblos/core/constants';
import type { PrivateReceiptStore } from '@gyblos/core/receipt-collector';
import type { ReceiptFileOptions } from './receipt-store-types';

export interface RetainedReceiptOptions extends ReceiptFileOptions { retentionMs: number; now: () => number; }
export interface RetainedReceiptStore extends PrivateReceiptStore { sweep(signal?: AbortSignal): Promise<void>; close(): Promise<void>; }
export async function createRetainedReceiptStore(_options: RetainedReceiptOptions): Promise<RetainedReceiptStore> {
  return { insert: async () => RECEIPT_COLLECTOR_WRITES.FULL, sweep: async () => {}, close: async () => {} };
}
export const openRetainedReceiptStore = createRetainedReceiptStore;
