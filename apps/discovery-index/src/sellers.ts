// Owns GET /v1/sellers: strict query parsing, deterministic paging and a size-bounded page body.
// Signed envelopes are embedded byte-for-byte as published; ranking is the buyer's job.
import { controlIdentifier } from '@gyblos/protocol/control-validation';

import { DISCOVERY_INDEX_LIMITS, INDEX_ERRORS } from './constants';
import { indexFail, protocolStep } from './errors';
import type { DiscoveryStorage, SellerCursor, SellerQuery } from './storage';

const QUERY_KEYS: ReadonlySet<string> = new Set(['model', 'limit', 'cursor']);
const LIMIT = new RegExp(
  `^[1-9][0-9]{0,${DISCOVERY_INDEX_LIMITS.maxLimitDigits - 1}}$`,
);
const CURSOR = new RegExp(
  `^(0|[1-9][0-9]{0,${DISCOVERY_INDEX_LIMITS.maxCursorIssuedDigits - 1}})-([0-9a-f]{64})$`,
);

export type SellersQuery = Omit<SellerQuery, 'now'>;

function invalidQuery(): never {
  return indexFail(INDEX_ERRORS.INVALID_QUERY);
}

function parseCursor(value: string): SellerCursor {
  const match = CURSOR.exec(value);
  const issuedAt = Number(match?.[1]);
  if (!match?.[2] || !Number.isSafeInteger(issuedAt)) invalidQuery();
  return { issuedAt, nodeId: match[2] };
}

// Missing/malformed model, malformed limit or cursor, unknown or repeated parameters: 400.
export async function parseSellersQuery(url: string): Promise<SellersQuery> {
  const params = new URL(url).searchParams;
  for (const key of new Set(params.keys()))
    if (!QUERY_KEYS.has(key) || params.getAll(key).length !== 1) invalidQuery();
  const model = await protocolStep(
    () => controlIdentifier(params.get('model')),
    () => INDEX_ERRORS.INVALID_QUERY,
  );
  let limit: number = DISCOVERY_INDEX_LIMITS.defaultSellers;
  const requested = params.get('limit');
  if (requested !== null) {
    if (!LIMIT.test(requested)) invalidQuery();
    limit = Math.min(Number(requested), DISCOVERY_INDEX_LIMITS.maxSellers);
  }
  const cursor = params.get('cursor');
  return { model, limit, after: cursor === null ? null : parseCursor(cursor) };
}

interface PageItem {
  text: string;
  issuedAt: number;
  nodeId: string;
}

// Stops before `limit` entries or the byte cap and returns the cursor of the last included entry.
export async function sellersPage(
  storage: DiscoveryStorage,
  query: SellersQuery,
  now: number,
  maxResponseBytes: number,
): Promise<string> {
  const rows = await storage.list({ ...query, now, limit: query.limit + 1 });
  const encoder = new TextEncoder();
  const items: PageItem[] = [];
  let size = DISCOVERY_INDEX_LIMITS.responseFramingBytes;
  let next: string | null = null;
  for (const row of rows) {
    const text = `{"catalog":${row.catalogJson},"presence":${row.presenceJson}}`;
    const bytes = encoder.encode(text).byteLength + 1;
    const last = items.at(-1);
    if (items.length === query.limit || size + bytes > maxResponseBytes) {
      next = last ? `${last.issuedAt}-${last.nodeId}` : null;
      break;
    }
    items.push({ text, issuedAt: row.issuedAt, nodeId: row.nodeId });
    size += bytes;
  }
  const sellers = items.map((item) => item.text).join(',');
  return `{"sellers":[${sellers}],"next":${JSON.stringify(next)},"generatedAt":${now}}`;
}
