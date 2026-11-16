// Owns the collector storage port and an in-memory implementation for tests and development. Raw rows
// are append-only; the receipt table keeps the first accepted versions and first report time per role.
import {
  PUBLIC_RECEIPT_MERGES,
  type PublicReceiptMerge,
} from '@gyblos/core/constants';
import type { PublicReceiptEntry } from '@gyblos/core/public-receipts';
import type { P2PRole } from '@gyblos/protocol/constants';
import type { SignedReceiptUpload } from '@gyblos/protocol/receipt-upload';

// One accepted envelope. `json` and `signature` are kept so attribution can be re-verified later.
export interface EnvelopeRow {
  id: string;
  upload: SignedReceiptUpload['upload'];
  signature: string;
  json: string;
  receivedAt: number;
}
// One item as reported by one side, whatever the merge result.
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
// A merge outcome for one key: the entry to keep and whether the incoming entry conflicted.
export interface ReceiptWrite {
  role: P2PRole;
  merge: PublicReceiptMerge;
  stored: PublicReceiptEntry;
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
  // Atomic: the envelope, every report, receipt upserts and conflicts, or nothing.
  commit(write: CollectorWrite, now: number): Promise<CommitResult>;
}

export const isConflict = (merge: PublicReceiptMerge) =>
  merge === PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT ||
  merge === PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT;

export interface MemoryCollector {
  storage: CollectorStorage;
  envelopes: EnvelopeRow[];
  reports: ReportRow[];
  entries: Map<string, PublicReceiptEntry>;
  firstReports: Map<string, Partial<Record<P2PRole, number>>>;
  conflicts: {
    key: string;
    merge: PublicReceiptMerge;
    entry: PublicReceiptEntry;
  }[];
}
export function createMemoryStorage(): MemoryCollector {
  const memory: MemoryCollector = {
    storage: undefined as never,
    envelopes: [],
    reports: [],
    entries: new Map(),
    firstReports: new Map(),
    conflicts: [],
  };
  const nonces = new Set<string>();
  memory.storage = {
    readEntries(keys) {
      const found = new Map<string, PublicReceiptEntry>();
      for (const key of keys) {
        const entry = memory.entries.get(key);
        if (entry) found.set(key, entry);
      }
      return Promise.resolve(found);
    },
    commit(write, now) {
      const nonce = `${write.envelope.upload.uploaderNodeId}:${write.envelope.upload.nonce}`;
      if (nonces.has(nonce)) return Promise.resolve(COMMIT_RESULTS.REPLAYED);
      nonces.add(nonce);
      memory.envelopes.push(write.envelope);
      memory.reports.push(...write.reports);
      for (const item of write.receipts) {
        memory.entries.set(item.stored.key, item.stored);
        const first = memory.firstReports.get(item.stored.key) ?? {};
        first[item.role] ??= now;
        memory.firstReports.set(item.stored.key, first);
        if (isConflict(item.merge))
          memory.conflicts.push({
            key: item.stored.key,
            merge: item.merge,
            entry: item.incoming,
          });
      }
      return Promise.resolve(COMMIT_RESULTS.COMMITTED);
    },
  };
  return memory;
}
