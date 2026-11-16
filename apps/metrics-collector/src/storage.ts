// Owns the collector storage port. Adapters apply core's merge rule (mergePublicReceipt) at commit time.
// Raw rows are append-only; the receipt table keeps the first accepted versions and first report times.
import type { PublicReceiptMerge } from '@gyblos/core/constants';
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
  sellerDigest: string;
  buyerDigest: string | null;
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
