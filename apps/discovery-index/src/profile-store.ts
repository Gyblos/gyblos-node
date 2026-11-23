export interface SellerProfileRow {
  nodeId: string;
  name: string;
  issuedAt: number;
  signature: string;
  held: false;
}
export interface SellerProfileTombstone {
  nodeId: string;
  name: null;
  issuedAt: number;
  signature: null;
  held: boolean;
}
export type StoredSellerProfile = SellerProfileRow | SellerProfileTombstone;

export const sellerProfileTombstone = (
  nodeId: string,
  issuedAt: number,
  held = false,
): SellerProfileTombstone => ({
  nodeId,
  name: null,
  issuedAt,
  signature: null,
  held,
});

export interface SellerProfileStore {
  get(nodeId: string): Promise<StoredSellerProfile | null>;
  put(entry: StoredSellerProfile): Promise<boolean>;
  names(
    nodeIds: readonly string[],
  ): Promise<{ nodeId: string; name: string }[]>;
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
      if (current && (current.held || current.issuedAt >= entry.issuedAt))
        return false;
      entries.set(entry.nodeId, { ...entry });
      return true;
    },
    async names(nodeIds) {
      return [...new Set(nodeIds)]
        .flatMap((nodeId) => {
          const entry = entries.get(nodeId);
          return entry?.name ? [{ nodeId, name: entry.name }] : [];
        })
        .sort((left, right) => byNodeId(left.nodeId, right.nodeId));
    },
  };
}
