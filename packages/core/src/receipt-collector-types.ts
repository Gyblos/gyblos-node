// Defines the private free-receipt ingestion and atomic-store boundary; no default backend or exporter.
import type { ConfirmedReceipt } from '@gyblos/protocol/receipt-channel';

import type {
  ReceiptCollectorStatus,
  ReceiptCollectorWrite,
} from './constants';

export interface PrivateFreeReceipt {
  // Canonical [sellerNodeId, buyerNodeId, requestId]; digest changes cannot evade conflict detection.
  key: string;
  fingerprint: string;
  receipt: ConfirmedReceipt;
}
export interface PrivateReceiptStore {
  // Atomically insert absent keys, deduplicate identical fingerprints and preserve conflicts.
  // Enforce capacity/retention, private access and abort-before-commit in the implementation.
  insert(
    entry: PrivateFreeReceipt,
    signal?: AbortSignal,
  ): Promise<ReceiptCollectorWrite>;
}
export interface ReceiptCollectorResult {
  status: ReceiptCollectorStatus;
}
