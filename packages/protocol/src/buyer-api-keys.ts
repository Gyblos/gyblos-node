// Public local-buyer key contracts; credentials never enter signed inference messages.
import { buyerAtomic } from './buyer-api';
import {
  BUYER_API,
  BUYER_API_KEYS,
  BUYER_KEY_ACTION,
  BUYER_KEY_CODES,
  type BuyerKeyCode,
} from './buyer-api/constants';

export {
  BUYER_API_KEYS,
  BUYER_KEY_ACTION,
  BUYER_KEY_CHARGE,
  BUYER_KEY_CODES,
  type BuyerKeyCharge,
  type BuyerKeyCode,
} from './buyer-api/constants';
export class BuyerApiKeyError extends Error {
  constructor(readonly code: BuyerKeyCode) {
    super(code);
    this.name = 'BuyerApiKeyError';
  }
}
export function buyerKeyFail(
  code: BuyerKeyCode = BUYER_KEY_CODES.INVALID,
): never {
  throw new BuyerApiKeyError(code);
}
export interface BuyerKeyScope {
  network: string;
  mint: string;
  payer: string;
}
export interface BuyerApiKeySummary {
  id: string;
  name: string;
  limitAtomic: string;
  spentAtomic: string;
  settledAtomic: string;
  approvedAtomic: string;
  reservedAtomic: string;
  revoked: boolean;
}
export interface BuyerApiKeysSnapshot {
  version: typeof BUYER_API_KEYS.VERSION;
  scope: BuyerKeyScope;
  keys: BuyerApiKeySummary[];
  blocked: boolean;
}
export function keyObject(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return buyerKeyFail();
  const fields = Object.fromEntries(Object.entries(value));
  if (Object.keys(fields).sort().join(',') !== [...names].sort().join(','))
    return buyerKeyFail();
  return fields;
}
export function parseBuyerKeyScope(value: unknown): BuyerKeyScope {
  const row = keyObject(value, ['network', 'mint', 'payer']);
  if (
    typeof row.network !== 'string' ||
    !row.network ||
    row.network.length > BUYER_API_KEYS.MAX_BINDING ||
    typeof row.mint !== 'string' ||
    !BUYER_API.ADDRESS_PATTERN.test(row.mint) ||
    typeof row.payer !== 'string' ||
    !BUYER_API.ADDRESS_PATTERN.test(row.payer)
  )
    return buyerKeyFail();
  return { network: row.network, mint: row.mint, payer: row.payer };
}
export function parseBuyerApiKeySummary(value: unknown): BuyerApiKeySummary {
  const row = keyObject(value, [
    'id',
    'name',
    'limitAtomic',
    'spentAtomic',
    'settledAtomic',
    'approvedAtomic',
    'reservedAtomic',
    'revoked',
  ]);
  if (
    typeof row.id !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.id) ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > BUYER_API_KEYS.MAX_NAME ||
    typeof row.revoked !== 'boolean' ||
    !buyerAtomic(row.limitAtomic) ||
    !buyerAtomic(row.spentAtomic) ||
    !buyerAtomic(row.settledAtomic) ||
    !buyerAtomic(row.approvedAtomic) ||
    !buyerAtomic(row.reservedAtomic) ||
    BigInt(row.spentAtomic) !==
      BigInt(row.settledAtomic) + BigInt(row.approvedAtomic) ||
    BigInt(row.spentAtomic) + BigInt(row.reservedAtomic) >
      BigInt(row.limitAtomic)
  )
    return buyerKeyFail();
  return {
    id: row.id,
    name: row.name,
    limitAtomic: row.limitAtomic,
    spentAtomic: row.spentAtomic,
    settledAtomic: row.settledAtomic,
    approvedAtomic: row.approvedAtomic,
    reservedAtomic: row.reservedAtomic,
    revoked: row.revoked,
  };
}
export function parseBuyerApiKeysSnapshot(
  value: unknown,
): BuyerApiKeysSnapshot {
  const row = keyObject(value, ['version', 'scope', 'keys', 'blocked']);
  if (
    row.version !== BUYER_API_KEYS.VERSION ||
    !Array.isArray(row.keys) ||
    row.keys.length > BUYER_API_KEYS.MAX_KEYS ||
    typeof row.blocked !== 'boolean'
  )
    return buyerKeyFail();
  const keys = row.keys.map(parseBuyerApiKeySummary);
  if (new Set(keys.map((key) => key.id)).size !== keys.length)
    return buyerKeyFail();
  return {
    version: row.version,
    scope: parseBuyerKeyScope(row.scope),
    keys,
    blocked: row.blocked,
  };
}

export type BuyerApiKeyCommand =
  | {
      action: typeof BUYER_KEY_ACTION.CREATE;
      name: string;
      limitAtomic: string;
    }
  | { action: typeof BUYER_KEY_ACTION.REVOKE; id: string };
export function parseBuyerApiKeyCommand(value: unknown): BuyerApiKeyCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return buyerKeyFail();
  const row = Object.fromEntries(Object.entries(value));
  if (row.action === BUYER_KEY_ACTION.CREATE) {
    keyObject(row, ['action', 'name', 'limitAtomic']);
    if (
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > BUYER_API_KEYS.MAX_NAME ||
      !buyerAtomic(row.limitAtomic)
    )
      return buyerKeyFail();
    return {
      action: row.action,
      name: row.name.trim(),
      limitAtomic: row.limitAtomic,
    };
  }
  if (row.action === BUYER_KEY_ACTION.REVOKE) {
    keyObject(row, ['action', 'id']);
    if (typeof row.id !== 'string' || !BUYER_API.POLICY_PATTERN.test(row.id))
      return buyerKeyFail();
    return { action: row.action, id: row.id };
  }
  return buyerKeyFail();
}
export function parseBuyerApiKeysReply(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return buyerKeyFail();
  const row = Object.fromEntries(Object.entries(value));
  keyObject(
    row,
    row.created === undefined ? ['snapshot'] : ['snapshot', 'created'],
  );
  const snapshot = parseBuyerApiKeysSnapshot(row.snapshot);
  if (row.created === undefined) return { snapshot, created: undefined };
  const created = keyObject(row.created, ['id', 'secret']);
  if (
    typeof created.id !== 'string' ||
    !snapshot.keys.some((key) => key.id === created.id && !key.revoked) ||
    typeof created.secret !== 'string' ||
    !BUYER_API_KEYS.TOKEN_PATTERN.test(created.secret)
  )
    return buyerKeyFail();
  return { snapshot, created: { id: created.id, secret: created.secret } };
}
