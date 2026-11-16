// Owns the in-memory collector storage for tests and development. It applies the same write rule as
// D1 (core's mergePublicReceipt at commit time), so behavior matches the production adapter.
import {
  PUBLIC_RECEIPT_MERGES,
  type PublicReceiptMerge,
} from '@gyblos/core/constants';
import {
  mergePublicReceipt,
  type PublicReceiptEntry,
} from '@gyblos/core/public-receipts';
import type { P2PRole } from '@gyblos/protocol/constants';

import {
  COMMIT_RESULTS,
  type CollectorStorage,
  type EnvelopeRow,
  type ObservationRow,
  type ReportRow,
} from './storage';

export interface MemoryCollector {
  storage: CollectorStorage;
  envelopes: EnvelopeRow[];
  reports: ReportRow[];
  entries: Map<string, PublicReceiptEntry>;
  firstReports: Map<string, Partial<Record<P2PRole, number>>>;
  history: { key: string; status: string; at: number }[];
  observations: ObservationRow[];
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
    observations: [],
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
      const nonce = `${write.envelope.uploaderNodeId}:${write.envelope.nonce}`;
      if (nonces.has(nonce)) return Promise.resolve(COMMIT_RESULTS.REPLAYED);
      nonces.add(nonce);
      memory.envelopes.push(write.envelope);
      memory.reports.push(...write.reports);
      for (const { role, incoming } of write.receipts) {
        const { merge, entry } = mergePublicReceipt(
          memory.entries.get(incoming.key) ?? null,
          incoming,
        );
        memory.entries.set(incoming.key, entry);
        if (
          merge === PUBLIC_RECEIPT_MERGES.INSERT ||
          merge === PUBLIC_RECEIPT_MERGES.UPGRADE
        )
          memory.history.push({
            key: incoming.key,
            status: entry.status,
            at: now,
          });
        if (
          merge === PUBLIC_RECEIPT_MERGES.SELLER_CONFLICT ||
          merge === PUBLIC_RECEIPT_MERGES.BUYER_CONFLICT
        )
          memory.conflicts.push({ key: incoming.key, merge, entry: incoming });
        const first = memory.firstReports.get(incoming.key) ?? {};
        first[role] ??= now;
        memory.firstReports.set(incoming.key, first);
      }
      return Promise.resolve(COMMIT_RESULTS.COMMITTED);
    },
    commitObservations(write) {
      const nonce = `${write.envelope.uploaderNodeId}:${write.envelope.nonce}`;
      if (nonces.has(nonce)) return Promise.resolve(COMMIT_RESULTS.REPLAYED);
      nonces.add(nonce);
      memory.envelopes.push(write.envelope);
      memory.observations.push(...write.events);
      return Promise.resolve(COMMIT_RESULTS.COMMITTED);
    },
  };
  return { ...memory, storage };
}
