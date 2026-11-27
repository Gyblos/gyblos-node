// Validates the private permission ledger; it contains hashes and financial amounts, never prompts.
import { BUYER_API, buyerAtomic } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_CODES,
  buyerKeyFail,
  keyObject,
  parseBuyerApiKeySummary,
  parseBuyerKeyScope,
  type BuyerApiKeySummary,
  type BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';

export interface BuyerKeyRecord extends BuyerApiKeySummary {
  digest: string;
}
export interface BuyerKeyReservation {
  id: string;
  keyId: string;
  maxAtomic: string;
  requestId: string;
  requestDigest: string;
  sellerNodeId: string;
  executionDigest?: string;
}
export interface BuyerKeyState {
  version: typeof BUYER_API_KEYS.VERSION;
  scope: BuyerKeyScope;
  keys: BuyerKeyRecord[];
  pending: BuyerKeyReservation[];
}
function parseKey(value: unknown): BuyerKeyRecord {
  const row = keyObject(value, [
    'id',
    'name',
    'limitAtomic',
    'spentAtomic',
    'settledAtomic',
    'approvedAtomic',
    'reservedAtomic',
    'revoked',
    'digest',
  ]);
  const { digest, ...summary } = row;
  if (typeof digest !== 'string' || !BUYER_API_KEYS.DIGEST_PATTERN.test(digest))
    return buyerKeyFail();
  return { ...parseBuyerApiKeySummary(summary), digest };
}
function reservation(value: unknown): BuyerKeyReservation {
  const row = keyObject(value, [
    'id',
    'keyId',
    'maxAtomic',
    'requestId',
    'requestDigest',
    'sellerNodeId',
    ...(value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'executionDigest')
      ? ['executionDigest']
      : []),
  ]);
  if (
    (row.executionDigest !== undefined &&
      (typeof row.executionDigest !== 'string' ||
        !BUYER_API_KEYS.DIGEST_PATTERN.test(row.executionDigest))) ||
    typeof row.id !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.id) ||
    typeof row.keyId !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.keyId) ||
    !buyerAtomic(row.maxAtomic) ||
    typeof row.requestId !== 'string' ||
    !row.requestId ||
    row.requestId.length > BUYER_API_KEYS.MAX_BINDING ||
    typeof row.requestDigest !== 'string' ||
    !BUYER_API_KEYS.DIGEST_PATTERN.test(row.requestDigest) ||
    typeof row.sellerNodeId !== 'string' ||
    !BUYER_API_KEYS.DIGEST_PATTERN.test(row.sellerNodeId)
  )
    return buyerKeyFail();
  return {
    id: row.id,
    keyId: row.keyId,
    maxAtomic: row.maxAtomic,
    requestId: row.requestId,
    requestDigest: row.requestDigest,
    sellerNodeId: row.sellerNodeId,
    ...(typeof row.executionDigest === 'string' && {
      executionDigest: row.executionDigest,
    }),
  };
}
export function buyerKeyState(
  text: string | undefined,
  scope: BuyerKeyScope,
): BuyerKeyState {
  if (text === undefined)
    return { version: BUYER_API_KEYS.VERSION, scope, keys: [], pending: [] };
  try {
    const value: unknown = JSON.parse(text);
    const row = keyObject(value, ['version', 'scope', 'keys', 'pending']);
    const savedScope = parseBuyerKeyScope(row.scope);
    if (
      row.version !== BUYER_API_KEYS.VERSION ||
      savedScope.network !== scope.network ||
      savedScope.mint !== scope.mint ||
      savedScope.payer !== scope.payer ||
      !Array.isArray(row.keys) ||
      row.keys.length > BUYER_API_KEYS.MAX_KEYS ||
      !Array.isArray(row.pending) ||
      row.pending.length > BUYER_API_KEYS.MAX_KEYS
    )
      return buyerKeyFail();
    const keys = row.keys.map(parseKey);
    const pending = row.pending.map(reservation);
    if (
      new Set(keys.map((key) => key.id)).size !== keys.length ||
      new Set(keys.map((key) => key.digest)).size !== keys.length ||
      new Set(pending.map((item) => item.id)).size !== pending.length ||
      pending.some((item) => !keys.some((key) => key.id === item.keyId))
    )
      return buyerKeyFail();
    for (const key of keys)
      if (
        pending
          .filter((item) => item.keyId === key.id)
          .reduce((sum, item) => sum + BigInt(item.maxAtomic), 0n) !==
        BigInt(key.reservedAtomic)
      )
        return buyerKeyFail();
    return { version: row.version, scope: savedScope, keys, pending };
  } catch {
    return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
  }
}
export function keyReservation(
  value: Omit<BuyerKeyReservation, 'id' | 'keyId'>,
  id: string,
  keyId: string,
) {
  return reservation({ ...value, id, keyId });
}

export function buyerKeyReviewQueue(
  pendingRows: readonly BuyerKeyReservation[],
  active: ReadonlyMap<string, AbortController>,
  checked: ReadonlySet<string>,
  manual: boolean,
) {
  const pending = pendingRows.filter(
    (row) =>
      !active.has(row.id) &&
      !pendingRows.some(
        (other) =>
          other.id !== row.id &&
          other.requestId === row.requestId &&
          other.sellerNodeId === row.sellerNodeId,
      ),
  );
  const unchecked = pending.filter((row) => !checked.has(row.id));
  return manual
    ? [...unchecked, ...pending.filter((row) => checked.has(row.id))]
    : unchecked;
}

export function bindKeyExecution(
  pending: readonly BuyerKeyReservation[],
  id: string,
  keyId: string,
  requestId: string,
  executionDigest: string,
  signal: AbortSignal,
) {
  const current = pending.find((item) => item.id === id);
  if (
    !current ||
    current.requestId !== requestId ||
    current.executionDigest ||
    signal.aborted
  )
    return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
  const bound = keyReservation({ ...current, executionDigest }, id, keyId);
  return pending.map((item) => (item.id === id ? bound : item));
}
