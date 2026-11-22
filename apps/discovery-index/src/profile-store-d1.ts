import { asc, eq, isNotNull, lt } from 'drizzle-orm';

import { parseSellerName } from '@gyblos/protocol/profile-claim';

import { createD1Orm, type D1Database, type D1Row } from './d1-client';
import {
  sellerProfileTombstone,
  type SellerProfileStore,
  type StoredSellerProfile,
} from './profile-store';
import { sellerProfiles } from './schema';
import { integer, text } from './uptime-d1';

function unexpected(): never {
  throw new TypeError('Unexpected seller profile row.');
}
function storedName(value: unknown): string {
  const result = parseSellerName(value);
  return result.ok && result.name === value ? result.name : unexpected();
}
function storedProfile(row: D1Row): StoredSellerProfile {
  const nodeId = text(row.nodeId);
  const issuedAt = integer(row.issuedAt);
  if (row.name === null)
    return row.signature === null
      ? sellerProfileTombstone(nodeId, issuedAt)
      : unexpected();
  return {
    nodeId,
    name: storedName(row.name),
    issuedAt,
    signature: text(row.signature),
  };
}
const profileColumns = {
  nodeId: sellerProfiles.nodeId,
  name: sellerProfiles.name,
  issuedAt: sellerProfiles.issuedAt,
  signature: sellerProfiles.signature,
};

export function createD1SellerProfileStore(
  client: D1Database,
): SellerProfileStore {
  const database = createD1Orm(client);
  return {
    async get(nodeId) {
      const [row] = await database
        .select(profileColumns)
        .from(sellerProfiles)
        .where(eq(sellerProfiles.nodeId, nodeId));
      return row ? storedProfile(row) : null;
    },
    async put(entry) {
      const { nodeId: _nodeId, ...fields } = entry;
      const written = await database
        .insert(sellerProfiles)
        .values(entry)
        .onConflictDoUpdate({
          target: sellerProfiles.nodeId,
          set: fields,
          setWhere: lt(sellerProfiles.issuedAt, entry.issuedAt),
        })
        .returning({ nodeId: sellerProfiles.nodeId });
      return written.length === 1;
    },
    async named(limit) {
      const rows = await database
        .select({ nodeId: sellerProfiles.nodeId, name: sellerProfiles.name })
        .from(sellerProfiles)
        .where(isNotNull(sellerProfiles.name))
        .orderBy(asc(sellerProfiles.nodeId))
        .limit(limit);
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        name: storedName(row.name),
      }));
    },
  };
}
