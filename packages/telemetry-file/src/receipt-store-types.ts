// Defines the collector's optional private file backend; no role, home layout or uploader is selected.
import type { PrivateReceiptStore } from '@gyblos/core/receipt-collector';

export interface ReceiptFileOptions {
  path: string;
  maxEntries?: number;
  maxBytes?: number;
  maxPending?: number;
}
export interface ReceiptFileStore extends PrivateReceiptStore {
  close(): Promise<void>;
}
