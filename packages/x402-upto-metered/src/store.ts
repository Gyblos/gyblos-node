// In-memory channel and chain stores, for tests and single-process use, and the adapter that lets
// the SDK keep its pending signatures in the chain store. Durable stores implement the same
// interfaces (for example an atomic JSON file per seller).
import type { PendingSettlementStore } from '@x402/core/facilitator';

import type {
  UptoChainStore,
  UptoChannelRecord,
  UptoClaimRecord,
  UptoStore,
} from './types';

export function memoryUptoStore(): UptoStore {
  const records = new Map<string, UptoChannelRecord>();
  return {
    async get(channelId) {
      const record = records.get(channelId);
      return record && structuredClone(record);
    },
    async put(record) {
      records.set(record.channelId, structuredClone(record));
    },
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
  };
}

export function memoryUptoChainStore(): UptoChainStore {
  const deposits = new Map<string, number>();
  const claims = new Map<string, Omit<UptoClaimRecord, 'channelId'>>();
  const pending = new Map<string, string>();
  return {
    async getDeposit(channelId) {
      const sentAt = deposits.get(channelId);
      return sentAt === undefined ? undefined : { channelId, sentAt };
    },
    async putDeposit(record) {
      deposits.set(record.channelId, record.sentAt);
    },
    async getClaim(channelId) {
      const claim = claims.get(channelId);
      return claim && { channelId, ...claim };
    },
    async putClaim({ channelId, ...claim }) {
      claims.set(channelId, claim);
    },
    async getPending(key) {
      return pending.get(key);
    },
    async putPending(key, signature) {
      pending.set(key, signature);
    },
    async deletePending(key) {
      pending.delete(key);
    },
  };
}

// Adapts the chain store to the SDK's PendingSettlementStore, so a signature the SDK recorded as
// pending survives a restart and settle re-awaits it instead of sending again. Deletes are kept,
// so a claim that failed on chain can be rebuilt. A claim that landed and was then forgotten is
// found through settledClaim instead.
export function durablePendingStore(
  store: UptoChainStore,
): PendingSettlementStore {
  return {
    get: (key) => store.getPending(key),
    set: (key, signature) => store.putPending(key, signature),
    delete: (key) => store.deletePending(key),
  };
}
