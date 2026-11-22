export interface SellerProfileRow {
  nodeId: string;
  name: string;
  issuedAt: number;
  signature: string;
}
export interface SellerProfileTombstone {
  nodeId: string;
  name: null;
  issuedAt: number;
  signature: null;
}
export type StoredSellerProfile = SellerProfileRow | SellerProfileTombstone;

export const sellerProfileTombstone = (
  nodeId: string,
  issuedAt: number,
): SellerProfileTombstone => ({
  nodeId,
  name: null,
  issuedAt,
  signature: null,
});

export interface SellerProfileStore {
  get(nodeId: string): Promise<StoredSellerProfile | null>;
  put(entry: StoredSellerProfile): Promise<boolean>;
  named(limit: number): Promise<{ nodeId: string; name: string }[]>;
}

const byNodeId = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function createMemorySellerProfileStore(): SellerProfileStore {
  const entries = new Map<string, StoredSellerProfile>();
  return {
    async get(nodeId) {
      const entry = entries.get(nodeId);
      return entry ? { ...entry } : null;
    },
    async put(entry) {
      const current = entries.get(entry.nodeId);
      if (current && current.issuedAt >= entry.issuedAt) return false;
      entries.set(entry.nodeId, { ...entry });
      return true;
    },
    async named(limit) {
      return [...entries.values()]
        .flatMap((entry) =>
          entry.name === null
            ? []
            : [{ nodeId: entry.nodeId, name: entry.name }],
        )
        .sort((left, right) => byNodeId(left.nodeId, right.nodeId))
        .slice(0, limit);
    },
  };
}
