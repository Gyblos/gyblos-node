// Public spending metadata only; no credentials, signed payloads or RPC configuration.
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import {
  BUYER_API,
  buyerAtomic,
  parseBuyerApiPolicy,
  type BuyerApiPolicy,
} from '@gyblos/protocol/buyer-api';

import { DESKTOP_X402 } from './x402/constants';

export { DESKTOP_X402, X402_ACTION } from './x402/constants';
export interface X402Record {
  id: string;
  sessionId: string;
  at: number;
  chargeAtomic: string;
  transaction: string | null;
  free: boolean;
  policy: BuyerApiPolicy;
}
export interface X402Summary {
  available: boolean;
  active: boolean;
  blocked: boolean;
  sessionId: string | null;
  policy: BuyerApiPolicy | null;
  limitAtomic: string;
  spentAtomic: string;
  records: X402Record[];
}
export function emptyX402(): X402Summary {
  return {
    available: true,
    active: false,
    blocked: false,
    sessionId: null,
    policy: null,
    limitAtomic: '0',
    spentAtomic: '0',
    records: [],
  };
}
export function x402Id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DESKTOP_X402.MAX_ID &&
    /^[a-zA-Z0-9-]+$/.test(value)
  );
}
export function x402Policy(input: unknown) {
  const policy = parseBuyerApiPolicy(input);
  if (policy.network !== DEVNET)
    throw new Error('Only Solana devnet is supported');
  return policy;
}
export function x402Explorer(transaction: string) {
  if (!BUYER_API.SIGNATURE_PATTERN.test(transaction))
    throw new Error('Invalid transaction');
  return DESKTOP_X402.EXPLORER + transaction + '?cluster=devnet';
}
export function parseX402Summary(input: unknown): X402Summary {
  if (!input || typeof input !== 'object') throw new Error('Invalid session');
  const value = input as Record<string, unknown>;
  if (
    typeof value.available !== 'boolean' ||
    typeof value.active !== 'boolean' ||
    typeof value.blocked !== 'boolean' ||
    !buyerAtomic(value.limitAtomic) ||
    !buyerAtomic(value.spentAtomic) ||
    (value.sessionId !== null && !x402Id(value.sessionId)) ||
    !Array.isArray(value.records) ||
    value.records.length > DESKTOP_X402.MAX_RECORDS
  )
    throw new Error('Invalid session');
  const policy = value.policy === null ? null : x402Policy(value.policy);
  const records: X402Record[] = value.records.map((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid payment');
    const record = input as Record<string, unknown>;
    if (
      !x402Id(record.id) ||
      !x402Id(record.sessionId) ||
      typeof record.at !== 'number' ||
      !Number.isSafeInteger(record.at) ||
      record.at < 0 ||
      !buyerAtomic(record.chargeAtomic) ||
      typeof record.free !== 'boolean' ||
      (record.transaction !== null &&
        (typeof record.transaction !== 'string' ||
          !BUYER_API.SIGNATURE_PATTERN.test(record.transaction))) ||
      (record.free
        ? record.transaction !== null || record.chargeAtomic !== '0'
        : record.transaction === null)
    )
      throw new Error('Invalid payment');
    return {
      id: record.id,
      sessionId: record.sessionId,
      at: record.at,
      chargeAtomic: record.chargeAtomic,
      transaction: record.transaction,
      free: record.free,
      policy: x402Policy(record.policy),
    };
  });
  if (
    BigInt(value.spentAtomic) > BigInt(value.limitAtomic) ||
    (value.active && (!policy || value.sessionId === null))
  )
    throw new Error('Invalid budget');
  return {
    available: value.available,
    active: value.active,
    blocked: value.blocked,
    sessionId: value.sessionId,
    policy,
    limitAtomic: value.limitAtomic,
    spentAtomic: value.spentAtomic,
    records,
  };
}
export function x402Asset(policy: BuyerApiPolicy) {
  return policy.mint === DEVNET_USDC
    ? 'USDC · devnet'
    : 'test-token atomic units';
}
export function x402Amount(atomic: string, policy: BuyerApiPolicy) {
  if (policy.mint !== DEVNET_USDC) return atomic;
  const scale = BigInt(DESKTOP_X402.AMOUNT_SCALE);
  return (
    String(BigInt(atomic) / scale) +
    '.' +
    String(BigInt(atomic) % scale).padStart(DESKTOP_X402.ATOMIC_DECIMALS, '0')
  );
}
export function x402BudgetInput(value: string, policy: BuyerApiPolicy) {
  if (policy.mint !== DEVNET_USDC) {
    if (!buyerAtomic(value))
      throw new Error('Enter a whole number of atomic units');
    return value;
  }
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value))
    throw new Error('Enter a valid amount');
  const [whole, fraction = ''] = value.split('.');
  const atomic =
    BigInt(whole!) * BigInt(DESKTOP_X402.AMOUNT_SCALE) +
    BigInt(fraction.padEnd(DESKTOP_X402.ATOMIC_DECIMALS, '0'));
  if (!buyerAtomic(String(atomic))) throw new Error('Budget is too large');
  return String(atomic);
}
export interface X402Result {
  homeSelected?: boolean;
  summary: X402Summary;
  policy: BuyerApiPolicy | null;
  reply?: { text: string; model: string };
  error?: string;
}
export function parseX402Result(input: unknown): X402Result {
  if (!input || typeof input !== 'object') throw new Error('Buyer unavailable');
  const value = input as Record<string, unknown>;
  const result: X402Result = {
    summary: parseX402Summary(value.summary),
    policy: value.policy === null ? null : x402Policy(value.policy),
  };
  if (value.homeSelected !== undefined) {
    if (typeof value.homeSelected !== 'boolean')
      throw new Error('Invalid buyer selection');
    result.homeSelected = value.homeSelected;
  }
  if (value.error !== undefined) {
    if (
      typeof value.error !== 'string' ||
      value.error.length > DESKTOP_X402.MAX_PROMPT
    )
      throw new Error('Invalid buyer error');
    result.error = value.error;
  }
  if (value.reply !== undefined) {
    if (!value.reply || typeof value.reply !== 'object')
      throw new Error('Invalid reply');
    const reply = value.reply as Record<string, unknown>;
    if (
      typeof reply.text !== 'string' ||
      reply.text.length > DESKTOP_X402.MAX_RESPONSE ||
      typeof reply.model !== 'string' ||
      reply.model.length > BUYER_API.MAX_MODEL_LENGTH
    )
      throw new Error('Invalid reply');
    result.reply = { text: reply.text, model: reply.model };
  }
  return result;
}
