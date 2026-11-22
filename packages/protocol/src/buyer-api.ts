// Validates the public configuration of an authenticated local buyer, never keys or signed payloads.
import { BUYER_API } from './buyer-api/constants';
import type { TokenPricesV2 } from './control-types';

export {
  parseBuyerSellerChoice,
  type BuyerSellerChoice,
} from './buyer-api/seller-choice';
export { BUYER_API } from './buyer-api/constants';
export {
  BUYER_SIDECAR,
  isBuyerSessionConfigFailure,
} from './buyer-api/constants';
export interface BuyerApiPolicy {
  version: typeof BUYER_API.VERSION;
  policyId: string;
  model: string;
  maxTokens: number;
  maxAtomic: string;
  paidAuto?: true;
  autoPrices?: TokenPricesV2;
  depositAtomic?: string;
  lifetimeMs?: number;
  network: string;
  mint: string;
  payer: string;
}
export function buyerAtomic(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= BUYER_API.MAX_ATOMIC_DIGITS &&
    /^(0|[1-9][0-9]*)$/.test(value)
  );
}
export function parseAutoPrices(value: unknown): TokenPricesV2 {
  if (
    !value ||
    typeof value !== 'object' ||
    !('inputAtomicPerMtok' in value) ||
    !('outputAtomicPerMtok' in value) ||
    !buyerAtomic(value.inputAtomicPerMtok) ||
    !buyerAtomic(value.outputAtomicPerMtok)
  )
    throw new Error('Invalid Auto price limits');
  return {
    inputAtomicPerMtok: value.inputAtomicPerMtok,
    outputAtomicPerMtok: value.outputAtomicPerMtok,
  };
}
export function parseBuyerApiPolicy(input: unknown): BuyerApiPolicy {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid buyer policy');
  const value = input as Record<string, unknown>;
  if (
    value.version !== BUYER_API.VERSION ||
    typeof value.policyId !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(value.policyId) ||
    typeof value.model !== 'string' ||
    !value.model.length ||
    value.model.length > BUYER_API.MAX_MODEL_LENGTH ||
    typeof value.maxTokens !== 'number' ||
    !Number.isSafeInteger(value.maxTokens) ||
    value.maxTokens <= 0 ||
    !buyerAtomic(value.maxAtomic) ||
    (value.paidAuto !== undefined && value.paidAuto !== true) ||
    typeof value.network !== 'string' ||
    value.network.length > BUYER_API.MAX_MODEL_LENGTH ||
    typeof value.mint !== 'string' ||
    !BUYER_API.ADDRESS_PATTERN.test(value.mint) ||
    typeof value.payer !== 'string' ||
    !BUYER_API.ADDRESS_PATTERN.test(value.payer)
  )
    throw new Error('Invalid buyer policy');
  const session =
    value.depositAtomic === undefined && value.lifetimeMs === undefined
      ? {}
      : parseTerms(value);
  return {
    ...session,
    ...(value.autoPrices !== undefined && {
      autoPrices: parseAutoPrices(value.autoPrices),
    }),
    version: BUYER_API.VERSION,
    policyId: value.policyId,
    model: value.model,
    maxTokens: value.maxTokens,
    maxAtomic: value.maxAtomic,
    ...(value.paidAuto === true && { paidAuto: true }),
    network: value.network,
    mint: value.mint,
    payer: value.payer,
  };
}

function parseTerms(value: Record<string, unknown>) {
  if (
    !buyerAtomic(value.depositAtomic) ||
    value.depositAtomic === '0' ||
    typeof value.lifetimeMs !== 'number' ||
    !Number.isSafeInteger(value.lifetimeMs) ||
    value.lifetimeMs <= 0
  )
    throw new Error('Invalid buyer channel terms');
  return { depositAtomic: value.depositAtomic, lifetimeMs: value.lifetimeMs };
}
