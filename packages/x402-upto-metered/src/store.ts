// The in-memory channel store, for tests and single-process use; durable stores implement the same
// interface (for example an atomic JSON file per seller).
import type { UptoChannelRecord, UptoStore } from './types';

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
