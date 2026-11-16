// Owns the collector storage port and an in-memory implementation for tests and development. Raw rows
// are append-only; the receipt table keeps the first accepted versions and first report time per role.
import {
  PUBLIC_RECEIPT_MERGES,
  type PublicReceiptMerge,
} from '@gyblos/core/constants';
import type { PublicReceiptEntry } from '@gyblos/core/public-receipts';
import type { P2PRole } from '@gyblos/protocol/constants';
import type { ReceiptUploadV1 } from '@gyblos/protocol/receipt-upload';

// One accepted envelope, in canonical form with its signature, so attribution can be re-verified later.
export interface EnvelopeRow {
  id: string;
  upload: ReceiptUploadV1;
  signature: string;
  json: string;
  receivedAt: number;
}
// One item as reported by one side. `merge` is advisory: it comes from a read before the write.
export interface ReportRow {
  envelopeId: string;
  key: string;
  role: P2PRole;
  fingerprint: string;
  merge: PublicReceiptMerge;
  storedAt: number | null;
  startedAt: number | null;
  offerJson: string | null;
}
export interface ReceiptWrite {
  role: P2PRole;
  incoming: PublicReceiptEntry;
}
export interface CollectorWrite {
  envelope: EnvelopeRow;
  reports: ReportRow[];
  receipts: ReceiptWrite[];
}
export const COMMIT_RESULTS = {
  COMMITTED: 'committed',
  // The (uploader, nonce) pair was already stored; nothing from this write is kept.
  REPLAYED: 'replayed',
} as const;
export type CommitResult = (typeof COMMIT_RESULTS)[keyof typeof COMMIT_RESULTS];

export interface CollectorStorage {
  // Stored entries for these keys, as classified when first accepted.
  readEntries(
    keys: readonly string[],
  ): Promise<Map<string, PublicReceiptEntry>>;
  // Atomic: the envelope, every report, guarded receipt writes, status history and conflicts, or
  // nothing. Conflicts and first versions are decided against the state at write time.
  commit(write: CollectorWrite, now: number): Promise<CommitResult>;
}

// The write rule both stores apply at commit time: a new key is inserted; an existing one only gains
// its first buyer half for the same seller record; any other difference is the signer's conflict.
export function applyReceipt(
  existing: PublicReceiptEntry | undefined,
  incoming: PublicReceiptEntry,
): {
  stored: PublicReceiptEntry;
  changed: boolean;
  conflict: PublicReceiptMerge | null;
} {
  if (!existing) return { stored: incoming, changed: true, conflict: null };
  if (existing.sellerDigest !== incoming.sellerDigest)
    return {
      stored: existing,
      changed: false,
      conflict: PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT,
    };
  if (
    incoming.buyerDigest === null ||
    incoming.buyerDigest === existing.buyerDigest
  )
    return { stored: existing, changed: false, conflict: null };
  if (existing.buyerDigest === null)
    return { stored: incoming, changed: true, conflict: null };
  return {
    stored: existing,
    changed: false,
    conflict: PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT,
  };
}

export interface MemoryCollector {
  storage: CollectorStorage;
  envelopes: EnvelopeRow[];
  reports: ReportRow[];
  entries: Map<string, PublicReceiptEntry>;
  firstReports: Map<string, Partial<Record<P2PRole, number>>>;
  history: { key: string; status: string; at: number }[];
  conflicts: {
    key: string;
    merge: PublicReceiptMerge;
    entry: PublicReceiptEntry;
  }[];
}
export function createMemoryStorage(): MemoryCollector {
  const nonces = new Set<string>();
  const memory: Omit<MemoryCollector, 'storage'> = {
    envelopes: [],
    reports: [],
    entries: new Map(),
    firstReports: new Map(),
    history: [],
    conflicts: [],
  };
  const storage: CollectorStorage = {
    readEntries(keys) {
      const found = new Map<string, PublicReceiptEntry>();
      for (const key of keys) {
        const entry = memory.entries.get(key);
        if (entry) found.set(key, entry);
      }
      return Promise.resolve(found);
    },
    commit(write, now) {
      const { upload } = write.envelope;
      const nonce = `${upload.uploaderNodeId}:${upload.nonce}`;
      if (nonces.has(nonce)) return Promise.resolve(COMMIT_RESULTS.REPLAYED);
      nonces.add(nonce);
      memory.envelopes.push(write.envelope);
      memory.reports.push(...write.reports);
      for (const { role, incoming } of write.receipts) {
        const applied = applyReceipt(
          memory.entries.get(incoming.key),
          incoming,
        );
        memory.entries.set(incoming.key, applied.stored);
        if (applied.changed)
          memory.history.push({
            key: incoming.key,
            status: applied.stored.status,
            at: now,
          });
        if (applied.conflict)
          memory.conflicts.push({
            key: incoming.key,
            merge: applied.conflict,
            entry: incoming,
          });
        const first = memory.firstReports.get(incoming.key) ?? {};
        first[role] ??= now;
        memory.firstReports.set(incoming.key, first);
      }
      return Promise.resolve(COMMIT_RESULTS.COMMITTED);
    },
  };
  return { ...memory, storage };
}
