import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import { parseSellerName } from '@gyblos/protocol/profile-claim';

import { SELLER_PROFILE } from './constants';
import { createD1Orm, type D1Database, type D1Row } from './d1-client';
import {
  sellerProfileTombstone,
  type SellerProfileStore,
  type StoredSellerProfile,
} from './profile-store';
import { sellerProfiles } from './schema';
import { jsonTextValues } from './sqlite-expressions';
import { integer, text } from './uptime-d1';

const HELD = SELLER_PROFILE.held;
const OPEN = SELLER_PROFILE.open;

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
  const held = integer(row.held);
  if (row.name === null)
    return row.signature === null && (held === OPEN || held === HELD)
      ? sellerProfileTombstone(nodeId, issuedAt, held === HELD)
      : unexpected();
  if (held !== OPEN) return unexpected();
  return {
    nodeId,
    name: storedName(row.name),
    issuedAt,
    signature: text(row.signature),
    held: false,
  };
}
const profileColumns = {
  nodeId: sellerProfiles.nodeId,
  name: sellerProfiles.name,
  issuedAt: sellerProfiles.issuedAt,
  signature: sellerProfiles.signature,
  held: sellerProfiles.held,
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
      const values = { ...entry, held: entry.held ? HELD : OPEN };
      const { nodeId: _nodeId, ...fields } = values;
      const written = await database
        .insert(sellerProfiles)
        .values(values)
        .onConflictDoUpdate({
          target: sellerProfiles.nodeId,
          set: fields,
          setWhere: and(
            lt(sellerProfiles.issuedAt, entry.issuedAt),
            eq(sellerProfiles.held, OPEN),
          ),
        })
        .returning({ nodeId: sellerProfiles.nodeId });
      return written.length === 1;
    },
    async names(nodeIds) {
      if (nodeIds.length === 0) return [];
      const rows = await database
        .select({ nodeId: sellerProfiles.nodeId, name: sellerProfiles.name })
        .from(sellerProfiles)
        .where(
          and(
            isNotNull(sellerProfiles.name),
            inArray(sellerProfiles.nodeId, jsonTextValues(nodeIds)),
          ),
        )
        .orderBy(asc(sellerProfiles.nodeId));
      return rows.map((row) => ({
        nodeId: text(row.nodeId),
        name: storedName(row.name),
      }));
    },
  };
}
