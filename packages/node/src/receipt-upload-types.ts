// Defines the local upload acknowledgement boundary; no uploader or signed receipt fields live here.
import type { HomeEnvironment, HomeRole } from '@gyblos/config';
import type { ReceiptV1 } from '@gyblos/protocol/receipt';
import type { ReceiptStoreKey } from '@gyblos/transport-iroh/receipt-service';

export interface ReceiptUploadCursor {
  key: ReceiptStoreKey;
  fingerprint: string;
  storedAt: number;
  receipt: ReceiptV1;
}
export interface ReceiptUploadHealth {
  pendingEntries: number;
  pendingBytes: number;
  uploadedEntries: number;
  rejectedWrites: number;
  full: boolean;
}

export interface ReceiptStoreOptions {
  environment: HomeEnvironment;
  role: HomeRole;
  nodeId: string;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  retentionMs?: number;
  maxPendingEntries?: number;
  maxPendingBytes?: number;
}
