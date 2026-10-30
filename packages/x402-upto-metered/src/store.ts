// The in-memory channel store, for tests and single-process use; durable stores implement the same
// interface (for example an atomic JSON file per seller).
import type { PendingSettlementStore } from '@x402/core/facilitator';

import type { UptoChainStore, UptoChannelRecord, UptoStore } from './types';

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
  const claims = new Map<
    string,
    { chargedAtomic: string; transaction?: string }
  >();
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
  };
}

// The SDK's pending-settlement store, backed by the chain store and never forgetting: after a crash,
// settle re-awaits the signature it already broadcast instead of opening or claiming again.
export function durablePendingStore(
  store: UptoChainStore,
): PendingSettlementStore {
  return {
    get: (key) => store.getPending(key),
    set: (key, signature) => store.putPending(key, signature),
    // Kept on purpose: the SDK drops the entry once confirmed, which loses it across a crash.
    delete: async () => {},
  };
}
