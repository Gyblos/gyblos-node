// Defines the local upload acknowledgement boundary; no uploader or signed receipt fields live here.
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
