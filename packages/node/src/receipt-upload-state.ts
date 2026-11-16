// Upload-aware retention and local fingerprints; pending bodies never enter the eviction set.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@gyblos/protocol';
import type { ReceiptV1 } from '@gyblos/protocol/receipt';

import { RECEIPT_UPLOAD } from './constants';
import { receiptKey, type StoredReceipt } from './receipt-store-schema';
import type { ReceiptUploadHealth } from './receipt-upload-types';

export interface UploadEntry extends StoredReceipt {
  uploadedAt: number | null;
}
export interface UploadState {
  entries: Map<string, UploadEntry>;
  rejectedWrites: number;
}
export interface UploadLimits {
  maxEntries: number;
  maxBytes: number;
  retentionMs: number;
  maxPendingEntries: number;
  maxPendingBytes: number;
}
export function receiptFingerprint(receipt: ReceiptV1) {
  return createHash('sha256').update(canonicalJson(receipt)).digest('hex');
}
export function orderedReceiptEntries(state: UploadState) {
  return [...state.entries]
    .sort(([leftKey, leftEntry], [rightKey, rightEntry]) => {
      const time = leftEntry.storedAt - rightEntry.storedAt;
      return time || (leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1);
    })
    .map(([, entry]) => entry);
}
export function uploadHealth(
  state: UploadState,
  limits: UploadLimits,
): ReceiptUploadHealth {
  let pendingEntries = 0;
  let pendingBytes = 0;
  for (const entry of state.entries.values()) {
    if (entry.uploadedAt !== null) continue;
    pendingEntries++;
    pendingBytes += RECEIPT_UPLOAD.reservedEntryBytes;
  }
  return {
    pendingEntries,
    pendingBytes,
    uploadedEntries: state.entries.size - pendingEntries,
    rejectedWrites: state.rejectedWrites,
    full:
      pendingEntries >= limits.maxPendingEntries ||
      pendingBytes + RECEIPT_UPLOAD.reservedEntryBytes > limits.maxPendingBytes,
  };
}
export function trimUploaded(
  state: UploadState,
  limits: UploadLimits,
  now: number,
) {
  const entries = new Map(state.entries);
  const uploadedEntries = new Map(
    [...state.entries].filter(([, entry]) => entry.uploadedAt !== null),
  );
  const uploaded = orderedReceiptEntries({
    ...state,
    entries: uploadedEntries,
  });
  let bytes = uploaded.reduce(
    (sum, entry) => sum + Buffer.byteLength(canonicalJson(entry)) + 1,
    0,
  );
  let count = uploaded.length;
  const evicted: string[] = [];
  for (const entry of uploaded) {
    if (
      count <= limits.maxEntries &&
      bytes <= limits.maxBytes &&
      now - entry.storedAt < limits.retentionMs
    )
      continue;
    const key = receiptKey(entry.receipt);
    entries.delete(key);
    evicted.push(key);
    count--;
    bytes -= Buffer.byteLength(canonicalJson(entry)) + 1;
  }
  return { state: { entries, rejectedWrites: state.rejectedWrites }, evicted };
}
