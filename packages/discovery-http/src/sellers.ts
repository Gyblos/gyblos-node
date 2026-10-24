// Fetches seller candidates from an untrusted HTTP index and re-verifies every signed record locally.
// It must not rank, persist or vouch for owners: badges, stats and owner↔NodeId checks stay with the buyer.
import type { KnownSeller } from '@gyblos/core/seller-selection';
import {
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import { parsePublicV2, verifyPublicV2 } from '@gyblos/protocol/public-v2';

import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  HTTP_STATUS,
  STATUS_ERROR_MAP,
} from './constants.js';
import { discoveryFail } from './errors.js';
import {
  failStatus,
  indexUrl,
  isPlainObject,
  readJson,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http.js';

// Shaped for selectSellers: the caller adds `badge` and `openChannel` to form a KnownSeller.
export type DiscoveredSeller = Pick<KnownSeller, 'catalog'> & {
  presence: NonNullable<KnownSeller['presence']>;
  withdrawal: null;
};

export interface FetchSellersInput {
  baseUrl: string;
  model: string;
  fetch: DiscoveryFetch;
  // Clock used to check record lifetimes once the response has been read.
  now: () => number;
  timeoutMs?: number;
  limit?: number;
  cursor?: string;
}

export interface FetchSellersResult {
  sellers: DiscoveredSeller[];
  // Entries the index returned that failed local verification or repeated a NodeId.
  dropped: number;
  next: string | null;
  generatedAt: number;
}

const MODEL_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._~-]+$/;
const RESPONSE_KEYS = ['sellers', 'next', 'generatedAt'] as const;
const ENTRY_KEYS = ['catalog', 'presence'] as const;

function checkModel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > PUBLIC_RECORD_LIMITS.maxIdentifierCharacters ||
    !MODEL_PATTERN.test(value)
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  return value;
}

function isCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DISCOVERY_LIMITS.maxCursorCharacters &&
    CURSOR_PATTERN.test(value)
  );
}

function checkLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DISCOVERY_LIMITS.maxSellers
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  return value;
}

function sellersQuery(model: string, limit?: number, cursor?: string) {
  let query = `?model=${encodeURIComponent(model)}`;
  if (limit !== undefined) query += `&limit=${encodeURIComponent(limit)}`;
  if (cursor !== undefined) query += `&cursor=${encodeURIComponent(cursor)}`;
  return query;
}

interface SellersPage {
  sellers: unknown[];
  next: string | null;
  generatedAt: number;
}

function checkPage(value: unknown, maxSellers: number): SellersPage {
  if (!isPlainObject(value, RESPONSE_KEYS))
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  const { sellers, next, generatedAt } = value;
  if (
    !Array.isArray(sellers) ||
    sellers.length > maxSellers ||
    (next !== null && !isCursor(next)) ||
    typeof generatedAt !== 'number' ||
    !Number.isSafeInteger(generatedAt) ||
    generatedAt < 0
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  return { sellers, next, generatedAt };
}

// Returns null for any entry that fails protocol verification; unexpected errors propagate.
async function verifyEntry(
  entry: unknown,
  model: string,
  now: number,
): Promise<DiscoveredSeller | null> {
  if (!isPlainObject(entry, ENTRY_KEYS)) return null;
  try {
    const signed = entry.catalog;
    const claimed = parsePublicV2(
      isPlainObject(signed, ['record', 'signature']) ? signed.record : null,
    );
    const trust = { owner: claimed.owner, nodeId: claimed.nodeId, now };
    const catalog = await verifyPublicV2(signed, trust);
    if (
      catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG ||
      !catalog.models.some((listing) => listing.modelId === model)
    )
      return null;
    const presence = await verifyPublicV2(entry.presence, {
      ...trust,
      catalog,
    });
    if (presence.kind !== PUBLIC_RECORD_KINDS.PRESENCE) return null;
    return { catalog, presence, withdrawal: null };
  } catch (error) {
    if (error instanceof ControlError) return null;
    throw error;
  }
}

async function verifyPage(page: SellersPage, model: string, now: number) {
  const sellers: DiscoveredSeller[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of page.sellers) {
    const seller = await verifyEntry(entry, model, now);
    if (!seller || seen.has(seller.catalog.nodeId)) {
      dropped++;
      continue;
    }
    seen.add(seller.catalog.nodeId);
    sellers.push(seller);
  }
  return { sellers, dropped, next: page.next, generatedAt: page.generatedAt };
}

export async function fetchSellers(
  input: FetchSellersInput,
): Promise<FetchSellersResult> {
  if (!input || typeof input !== 'object' || typeof input.now !== 'function')
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const model = checkModel(input.model);
  const limit = checkLimit(input.limit);
  if (input.cursor !== undefined && !isCursor(input.cursor))
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const url = indexUrl(
    input.baseUrl,
    DISCOVERY_PATHS.sellers,
    sellersQuery(model, limit, input.cursor),
  );
  const request = {
    url,
    init: { method: 'GET', headers: { accept: 'application/json' } },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
  };
  const page = await withDeadline(request, async (response, aborted) => {
    if (response.status === HTTP_STATUS.BAD_REQUEST)
      failStatus(response, DISCOVERY_ERROR_CODES.INVALID_QUERY);
    if (response.status !== HTTP_STATUS.OK)
      failStatus(
        response,
        STATUS_ERROR_MAP.get(response.status) ??
          DISCOVERY_ERROR_CODES.HTTP_STATUS,
      );
    const body = await readJson(
      response,
      DISCOVERY_LIMITS.maxSellersResponseBytes,
      aborted,
    );
    return checkPage(body, limit ?? DISCOVERY_LIMITS.defaultSellers);
  });
  const now = input.now();
  if (!Number.isSafeInteger(now) || now < 0)
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  return verifyPage(page, model, now);
}
