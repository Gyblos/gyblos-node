// Replays canonical local mutations and snapshots; it never changes signed receipt formats or timestamps.
import type { HomeRole } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlArray,
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { sellerReceiptDigest, verifyReceipt } from '@gyblos/protocol/receipt';

import { RECEIPT_STORAGE, RECEIPT_UPLOAD } from './constants';
import { receiptUnavailable } from './receipt-file';
import {
  assertReceiptRole,
  parseReceiptSnapshot,
  receiptKey,
} from './receipt-store-schema';
import {
  receiptFingerprint,
  type UploadEntry,
  type UploadState,
} from './receipt-upload-state';

export interface ReceiptMutation {
  entry: UploadEntry | null;
  evicted: string[];
  rejectedWrites: number;
}
export function receiptSnapshot(
  state: UploadState,
  role: HomeRole,
  nodeId: string,
) {
  return (
    canonicalJson({
      schemaVersion: RECEIPT_UPLOAD.schemaVersion,
      role,
      nodeId,
      rejectedWrites: state.rejectedWrites,
      entries: [...state.entries.values()],
    }) + '\n'
  );
}
async function readEntry(
  value: unknown,
  role: HomeRole,
  nodeId: string,
): Promise<UploadEntry> {
  const input = controlObject(value, ['storedAt', 'uploadedAt', 'receipt']);
  const receipt = await verifyReceipt(input.receipt);
  assertReceiptRole(receipt, role, nodeId);
  const entry = {
    receipt,
    storedAt: controlInteger(input.storedAt),
    uploadedAt:
      input.uploadedAt === null ? null : controlInteger(input.uploadedAt),
  };
  if (
    Buffer.byteLength(canonicalJson(entry)) > RECEIPT_UPLOAD.reservedEntryBytes
  )
    receiptUnavailable();
  return entry;
}
async function assertReceiptUpdate(old: UploadEntry, entry: UploadEntry) {
  if (
    old.storedAt !== entry.storedAt ||
    (await sellerReceiptDigest(old.receipt.seller.record)) !==
      (await sellerReceiptDigest(entry.receipt.seller.record)) ||
    (old.receipt.buyer &&
      canonicalJson(old.receipt) !== canonicalJson(entry.receipt)) ||
    (old.uploadedAt !== null &&
      entry.uploadedAt !== null &&
      old.uploadedAt !== entry.uploadedAt) ||
    (old.uploadedAt !== null &&
      entry.uploadedAt === null &&
      (!entry.receipt.buyer || old.receipt.buyer))
  )
    receiptUnavailable();
}
async function applyReceiptMutation(
  state: UploadState,
  line: string,
  role: HomeRole,
  nodeId: string,
) {
  const raw: unknown = JSON.parse(line);
  const row = controlObject(raw, ['entry', 'evicted', 'rejectedWrites']);
  if (canonicalJson(raw) !== line) receiptUnavailable();
  const rejected = controlInteger(row.rejectedWrites, state.rejectedWrites);
  for (const key of controlArray(row.evicted, RECEIPT_STORAGE.maxEntries + 1)) {
    if (typeof key !== 'string' || state.entries.get(key)?.uploadedAt == null)
      receiptUnavailable();
    state.entries.delete(key);
  }
  if (row.entry !== null) {
    const entry = await readEntry(row.entry, role, nodeId);
    const key = receiptKey(entry.receipt);
    const old = state.entries.get(key);
    if (old) await assertReceiptUpdate(old, entry);
    state.entries.set(key, entry);
  }
  state.rejectedWrites = rejected;
  if (
    state.entries.size >
    RECEIPT_UPLOAD.maxPendingEntries + RECEIPT_STORAGE.maxEntries
  )
    receiptUnavailable();
}

export async function parseReceiptJournal(
  text: string,
  role: HomeRole,
  nodeId: string,
  trailingBytes: number,
) {
  const lines = text.slice(0, -1).split('\n');
  const first = lines[0];
  if (!first) receiptUnavailable();
  const header: unknown = JSON.parse(first);
  if (!header || typeof header !== 'object' || !('schemaVersion' in header))
    receiptUnavailable();
  const version = header.schemaVersion;
  if (version === RECEIPT_STORAGE.schemaVersion) {
    if (lines.length !== 1 || trailingBytes !== 0) receiptUnavailable();
    const entries = await parseReceiptSnapshot(text, role, nodeId);
    return {
      legacy: true,
      state: {
        entries: new Map(
          entries.map((row) => [
            receiptKey(row.receipt),
            { ...row, uploadedAt: null },
          ]),
        ),
        rejectedWrites: 0,
      },
    };
  }
  const input = controlObject(header, [
    'schemaVersion',
    'role',
    'nodeId',
    'entries',
    'rejectedWrites',
  ]);
  if (
    version !== RECEIPT_UPLOAD.schemaVersion ||
    input.role !== role ||
    input.nodeId !== nodeId ||
    canonicalJson(header) !== lines[0]
  )
    receiptUnavailable();
  const state: UploadState = {
    entries: new Map(),
    rejectedWrites: controlInteger(input.rejectedWrites),
  };
  for (const raw of controlArray(
    input.entries,
    RECEIPT_UPLOAD.maxPendingEntries + RECEIPT_STORAGE.maxEntries,
  )) {
    const entry = await readEntry(raw, role, nodeId);
    const key = receiptKey(entry.receipt);
    if (state.entries.has(key)) receiptUnavailable();
    state.entries.set(key, entry);
  }
  for (const line of lines.slice(1)) {
    await applyReceiptMutation(state, line, role, nodeId);
  }
  return { state, legacy: false };
}
export function uploadMatches(
  entry: UploadEntry | undefined,
  fingerprint: unknown,
) {
  return (
    !!entry && receiptFingerprint(entry.receipt) === controlHex(fingerprint)
  );
}
