// Owns the in-memory collector storage for tests and development. It applies the same write rule as
// D1 (applyReceipt), so behavior matches the production adapter.
import type { PublicReceiptMerge } from '@gyblos/core/constants';
import type { PublicReceiptEntry } from '@gyblos/core/public-receipts';
import type { P2PRole } from '@gyblos/protocol/constants';

import {
  applyReceipt,
  COMMIT_RESULTS,
  type CollectorStorage,
  type EnvelopeRow,
  type ReportRow,
} from './storage';

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
